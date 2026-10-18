import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashWagerPayload } from '../src/application/idempotency/wager-payload-hash.ts';
import { WagerTransactionKind } from '../src/domain/wager-transaction.ts';

const request = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
} as const;

describe('Hash do payload de idempotência da aposta', () => {
  it('Permanece estável independentemente da ordem das propriedades do objeto', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: WagerTransactionKind.Bet,
      gameId: 'game-1',
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    } as const;
    assert.equal(hashWagerPayload(request), hashWagerPayload(reordered));
  });

  it('Muda quando um campo de negócio é alterado', () => {
    const original = hashWagerPayload(request);
    assert.notEqual(
      original,
      hashWagerPayload({ ...request, money: { amount: '25.01', currency: 'BRL' } }),
    );
  });
});
