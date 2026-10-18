# Notas de arquitetura

## Autenticação e identidade do provedor

A autenticação não será implementada neste escopo. Não há integração ativa com Keycloak, validação de tokens, nem `AuthGuard` permissivo. O serviço não deve ser exposto a tráfego não confiável até que uma implementação de autenticação seja conectada.

O ponto de extensão é `ProviderIdentityPort`, em `src/application/ports/provider-identity.port.ts`. A camada de entrada deverá extrair o bearer token da requisição e chamar essa porta. Uma implementação futura baseada em Keycloak deverá validar assinatura com as chaves públicas/JWKS do realm, `issuer`, `audience`, expiração (`exp`), início de validade (`nbf`) e permissões exigidas. Depois, mapeará uma claim estável do provedor para o `providerId` interno e retornará a identidade autenticada. Token ausente, inválido, expirado ou sem permissão deverá falhar fechado; não se deve aceitar `providerId` fornecido livremente no corpo da operação como identidade autenticada.

O domínio recebe somente o `providerId` já autenticado e não conhece tokens, Keycloak, NestJS ou detalhes HTTP. O adaptador/guard NestJS que vier a ser criado será responsável por converter falhas de autenticação em resposta HTTP apropriada. Para consumidores de mensagens, a identidade do provedor deverá ser estabelecida por uma fronteira de confiança equivalente, sem reutilizar implicitamente o fluxo HTTP.

Essa separação permite adicionar Keycloak sem acoplar autenticação às regras financeiras. Até essa implementação existir, o contrato é apenas uma porta de arquitetura, não uma garantia de segurança em runtime.

## Estratégia de concorrência

A unidade de concorrência é a carteira. O aplicativo mantém as atualizações da carteira serializadas no nível do banco de dados usando bloqueio em nível de linha na linha da carteira, combinado com uma coluna de versão para controle otimista de novas tentativas. Isso evita um bloqueio global compartilhado, ao mesmo tempo que protege contra a perda de atualizações.

A invariante crítica é que o saldo, o lançamento contábil e o estado de obsolescência/caixa de saída são confirmados na mesma transação SQL. Se uma transação for repetida após uma falha de serialização, o sistema reproduz a mesma intenção comercial usando a mesma chave de idempotência. A aplicação adquire um advisory lock transacional do PostgreSQL por `(providerId, idempotencyKey)` antes de consultar ou inserir a transação; assim, chamadas iguais concorrentes, inclusive direcionadas a carteiras diferentes, observam o resultado já confirmado antes de decidir entre replay e conflito. O lock é liberado automaticamente no commit ou rollback.

Como o broker não é considerado a autoridade final, todas as invariantes financeiras residem em restrições e índices únicos do PostgreSQL. Exemplos incluem:

- Carteira única por `(player_id, currency)`
- Registro único por carteira/transação
- Verificação de `balance >= 0`
- `ledger.balance_before ± amount = ledger.balance_after`
- Chaves de idempotência únicas por transação de provedor

Isso mantém a correção em várias instâncias do aplicativo e em casos de interrupções temporárias do PostgreSQL ou SQS.

## Por que o banco de dados detém as garantias?

O banco de dados é a fonte da verdade. O código do aplicativo valida as transições, mas a verdadeira rede de segurança reside nas restrições de schema, nos índices únicos e nos limites de confirmação transacional. Isso garante que o serviço permaneça íntegro mesmo após reinicializações, eventos duplicados e referências fora de ordem.

## Backoff e processamento de referência diferido

As referências pendentes são repetidas com backoff exponencial usando uma janela de repetição limitada. Quando o orçamento de repetição se esgota, a transação transita para um estado de rejeição final com um código de falha específico que descreve a referência ausente. Isso mantém o registro de auditoria intacto e preserva a diferença entre uma rejeição puramente baseada em regras de negócio e uma dependência ausente.

## Persistência e migrations

O PostgreSQL é a autoridade para unicidade, não negatividade e imutabilidade. A migration MikroORM versionada em `migrations/` cria as tabelas e índices de wallets, wagering transactions, ledger, inbox e outbox. O método `down` remove o schema em ordem inversa. O saldo é `numeric(20,2)` e nunca passa por `number` no domínio.

O trigger do ledger bloqueia a linha da wallet, exige que `balance_before` corresponda ao saldo persistido e aplica `balance_after` e incremento de versão na mesma transação do insert. Para `OPENING`, a wallet nasce já com o saldo inicial e versão 1; o lançamento inicial deve ser crédito, partir de zero e ser o primeiro lançamento. `UPDATE` e `DELETE` de lançamentos são proibidos pelo banco. Entradas regulares têm unicidade por transação e wallet; reversões são únicas por referência e tipo.

## Contrato HTTP e respostas

As rotas previstas são `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`, `POST /wallets/:walletId/reconciliation`, `POST /wagering/transactions`, `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`. O cursor do ledger é opaco e ordenado por `(created_at, id)`.

O status HTTP não depende de interpretar mensagens:

| Situação | HTTP |
|---|---:|
| Payload inválido | 400 |
| Recurso inexistente | 404 |
| Wallet duplicada ou mesma idempotency key com hash diferente | 409 |
| Rejeição terminal por regra de negócio | 422 |
| Aceito aguardando referência/processamento assíncrono | 202 |
| Transação aplicada (inclusive replay idempotente) | 200; criação de wallet usa 201 |
| Dependência indisponível/erro transitório | 503 com `Retry-After` |

`POST /wagering/transactions` exige `Idempotency-Key`. A chave sugerida é `{providerId}:{externalTransactionId}`. O hash é SHA-256 de JSON canônico (chaves de objeto ordenadas lexicalmente) apenas dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` quando presente. A chave de idempotência e metadados de transporte não entram no hash. A resposta original, inclusive o saldo observado, é persistida para replay.

Reconciliação compara saldo armazenado ao saldo reconstruído por `SUM` do ledger (créditos positivos e débitos negativos); divergência retorna `consistent: false`, gera log estruturado e métrica, e nunca corrige dados automaticamente.

`GET /health/live` verifica somente que o processo responde. `GET /health/ready` verifica PostgreSQL e SQS e responde 503 quando uma dependência necessária não está disponível. Ambos são públicos e independentes de autenticação.

## SQS, inbox e outbox

As filas FIFO são `wager-transactions.fifo` e `wager-transactions-dlq.fifo`. O `MessageGroupId` recomendado é `walletId`; deduplicação FIFO é apenas otimização. O consumidor chama o mesmo caso de uso que o HTTP, registra `(consumerName, messageId)` na inbox na mesma transação financeira, e envia ack somente após o commit. Duplicata de inbox com hash igual é ignorada; hash divergente é erro permanente auditável. Erros de negócio são terminais e recebem ack; falhas transitórias não recebem ack para retry; payload inválido ou incompatível é encaminhado à DLQ após o limite configurado de 5 recebimentos. No SIGTERM, o worker para de receber, aguarda o processamento em curso até o prazo de encerramento e, se excedido, deixa a mensagem sem ack para redelivery.

Transação, alteração da wallet, ledger, inbox (para SQS) e eventos outbox são gravados na mesma transação PostgreSQL. Publishers usam `FOR UPDATE SKIP LOCKED` e lease com expiração para reivindicar linhas em paralelo. A publicação ocorre após o commit; se o processo cair antes de marcar como publicado, outro publisher tenta novamente. Portanto, a entrega de eventos é at-least-once e consumidores devem deduplicar por `eventId`.

Eventos versionados obrigatórios: `WagerTransactionProcessed` (incluindo `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` (somente saldo alterado) e `WagerTransactionPendingReference`. Cada tipo concreto define seu `eventType` e `version`; `data` serializa valores monetários como `{ amount, currency }`, nunca como instâncias `Money`.

## Observabilidade

Logs são JSON e incluem os identificadores de correlação disponíveis (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`), sem token, credencial ou payload financeiro completo. Métricas obrigatórias: transações por status, duplicatas, retries, mensagens em DLQ, conflitos de lock, idade da mensagem outbox mais antiga (outbox lag), latência de processamento e divergências de reconciliação. Liveness e readiness são checks separados.

## Implementação e validação

A primeira fatia executável inclui controllers HTTP, migrations PostgreSQL, casos de uso transacionais para wallets e apostas, adapters/workers SQS, inbox/outbox, health checks e métricas. As garantias de execução real ainda dependem de validar o ambiente PostgreSQL/LocalStack e os workers; os testes unitários não substituem os testes de integração nem comprovam comportamento com múltiplas instâncias.

O teste de concorrência HTTP em `tests/integration/wallet-concurrency.spec.ts` requer a API e o PostgreSQL em execução (`INTEGRATION_BASE_URL=http://localhost:3000 npm test`). Ele envia duas apostas concorrentes de R$ 80,00 em uma wallet de R$ 100,00 e 50 requisições idênticas em paralelo, conferindo o saldo, os débitos do ledger e a reconciliação. Sem `INTEGRATION_BASE_URL`, esse teste é ignorado. As demais verificações ainda necessárias incluem reinício após commit, redelivery/inbox, retry e DLQ do SQS, publishers concorrentes, três ou mais instâncias e concorrência distribuída entre processos.
