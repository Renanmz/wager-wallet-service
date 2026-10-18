import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

const baseUrl = process.env.INTEGRATION_BASE_URL;

interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface LedgerResponse {
  entries: Array<{ direction: string }>;
}

interface WagerResponse {
  transactionId: string;
  status: string;
  idempotentReplay: boolean;
  failureCode?: string;
}

describe('Concorrência de carteira com PostgreSQL', { skip: !baseUrl }, () => {
  it('Serializa duas apostas concorrentes e mantém o ledger igual ao saldo armazenado', async () => {
    const wallet = await createWallet('100.00');
    const walletDetails = await getJson<WalletResponse>(`/wallets/${wallet.id}`);
    const outcomes = await Promise.all([
      submitBet(wallet.id, '80.00', `race-a:${randomUUID()}`, randomUUID(), walletDetails.playerId),
      submitBet(wallet.id, '80.00', `race-b:${randomUUID()}`, randomUUID(), walletDetails.playerId),
    ]);

    assert.deepEqual(outcomes.map((item) => item.response.status).sort(), [200, 422]);
    assert.deepEqual(outcomes.map((item) => item.body.status).sort(), ['PROCESSED', 'REJECTED']);
    assert.equal(outcomes.find((item) => item.body.status === 'REJECTED')?.body.failureCode, 'INSUFFICIENT_FUNDS');
    const balance = await getJson<WalletResponse>(`/wallets/${wallet.id}`);
    assert.equal(balance.balance.amount, '20.00');
    const ledger = await getJson<LedgerResponse>(`/wallets/${wallet.id}/ledger?limit=100`);
    assert.equal(ledger.entries.filter((entry) => entry.direction === 'DEBIT').length, 1);

    const reconciliation = await postJson<{ consistent: boolean }>(`/wallets/${wallet.id}/reconciliation`, {});
    assert.equal(reconciliation.consistent, true);
  });

  it('Aplica um único débito para cinquenta requisições simultâneas idênticas', async () => {
    const wallet = await createWallet('100.00');
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const transaction = randomUUID();
    const walletDetails = await getJson<WalletResponse>(`/wallets/${wallet.id}`);
    const roundId = `round-${randomUUID()}`;
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => submitBet(
        wallet.id,
        '1.00',
        idempotencyKey,
        transaction,
        walletDetails.playerId,
        roundId,
      )),
    );

    assert.ok(outcomes.every((item) => item.response.status === 200));
    assert.ok(outcomes.every((item) => item.body.status === 'PROCESSED'));
    assert.equal(new Set(outcomes.map((item) => item.body.transactionId)).size, 1);
    assert.equal(outcomes.filter((item) => item.body.idempotentReplay === false).length, 1);
    const balance = await getJson<WalletResponse>(`/wallets/${wallet.id}`);
    assert.equal(balance.balance.amount, '99.00');
    const ledger = await getJson<LedgerResponse>(`/wallets/${wallet.id}/ledger?limit=100`);
    assert.equal(ledger.entries.filter((entry) => entry.direction === 'DEBIT').length, 1);
    const reconciliation = await postJson<{ consistent: boolean }>(`/wallets/${wallet.id}/reconciliation`, {});
    assert.equal(reconciliation.consistent, true);
  });
});

async function createWallet(initialAmount: string): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: randomUUID(),
      initialBalance: { amount: initialAmount, currency: 'BRL' },
    }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: string }>;
}

async function submitBet(
  walletId: string,
  amount: string,
  idempotencyKey: string,
  externalTransactionId: string,
  playerId: string,
  roundId = `round-${randomUUID()}`,
): Promise<{ response: Response; body: WagerResponse }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId: 'integration-test',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  });
  return { response, body: await response.json() as WagerResponse };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<T>;
}
