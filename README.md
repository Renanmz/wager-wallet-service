# Wager Wallet Service

Este projeto implementa o modelo de domínio principal para um serviço de carteira de apostas financeiras em TypeScript usando Bun.

A solução se concentra nas invariantes do ledger, no modelo de moeda imutável, nas proteções de saldo da carteira e nas transições de estado para transações de apostas.

## Principais regras de domínio

- O dinheiro é representado como uma string decimal exata com uma escala fixa de 2 casas decimais.
- A versão da carteira incrementa apenas quando o saldo muda.
- As entradas do ledger da carteira são criadas apenas quando ocorre uma transação que afeta o saldo.
- Operações repetidas ou duplicadas do provedor são tratadas por meio de chaves de idempotência e transições de estado determinísticas.
- O acesso simultâneo à carteira é tratado por meio de restrições em nível de banco de dados e bloqueio otimista/pessimista na camada de persistência.

## Verificação local (teste)

```bash
npm install
npm test
```

Os testes de domínio rodam sem infraestrutura externa. Para executar também os testes concorrentes contra PostgreSQL real, suba o ambiente local e informe a URL da API:

```bash
docker compose up --build -d
INTEGRATION_BASE_URL=http://localhost:3000 npm test
```

No PowerShell, depois de qualquer alteração no código, reconstrua e recrie os containers com `docker compose up --build -d`. Confira `docker compose logs --tail 100 api worker` e aguarde `Invoke-RestMethod http://localhost:3000/health/ready` responder `ready`. Então configure a variável e rode `npm.cmd test`:

```powershell
$env:INTEGRATION_BASE_URL = 'http://localhost:3000'
npm.cmd test
```

Os testes de integração verificam duas apostas concorrentes de R$ 80,00 sobre saldo de R$ 100,00 e 50 entregas simultâneas com a mesma chave de idempotência; sem a variável, ficam ignorados. A reconciliação considera o lançamento `OPENING`, e o teste conta separadamente os débitos. O fluxo da aplicação serializa requisições com a mesma chave usando advisory lock transacional no PostgreSQL.

O serviço `queue-init` usa o AWS SDK que já está instalado na imagem da aplicação para criar as filas no LocalStack; assim, não depende de uma imagem separada do AWS CLI. Depois de atualizar o projeto, execute `docker compose up --build -d` novamente.
