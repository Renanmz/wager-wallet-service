import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FailureCode,
  LedgerDirection,
  Money,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
  WalletLedgerEntry,
} from '../src/index.ts';

describe('Dinheiro', () => {
  it('Aceita valores decimais válidos e serializa com duas casas decimais', () => {
    const amount = Money.from({ amount: '25.00', currency: 'BRL' });
    assert.deepEqual(amount.toJSON(), { amount: '25.00', currency: 'BRL' });
    assert.equal(amount.toString(), '25.00');
  });

  it('Rejeita valores inválidos', () => {
    assert.throws(() => Money.from({ amount: '1e2', currency: 'BRL' }));
    assert.throws(() => Money.from({ amount: '25.001', currency: 'BRL' }));
    assert.throws(() => Money.from({ amount: '-1.00', currency: 'BRL' }));
    assert.throws(() => Money.from({ amount: '', currency: 'BRL' }));
  });

  it('Soma e subtrai valores monetários com exatidão', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '5.25', currency: 'BRL' });
    assert.deepEqual(a.add(b).toJSON(), { amount: '15.25', currency: 'BRL' });
    assert.deepEqual(a.subtract(b).toJSON(), { amount: '4.75', currency: 'BRL' });
  });
});

describe('Carteira', () => {
  it('é aberta com saldo válido e incrementa a versão somente quando há alteração', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    assert.equal(wallet.version, 1);
    wallet.credit(Money.from({ amount: '5.00', currency: 'BRL' }));
    assert.deepEqual(wallet.balance.toJSON(), { amount: '105.00', currency: 'BRL' });
    assert.equal(wallet.version, 2);
  });

  it('Rejeita saldos negativos', () => {
    const wallet = Wallet.open({
      id: 'w-2',
      playerId: 'player-2',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    assert.throws(() => wallet.debit(Money.from({ amount: '11.00', currency: 'BRL' })));
  });
});

describe('Transação de aposta', () => {
  it('Cria transações pendentes e as transiciona para processadas', () => {
    const tx = WagerTransaction.create({
      id: 't-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'key-1',
      payloadHash: 'hash-1',
      walletId: 'w-1',
      playerId: 'player-a',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });

    assert.equal(tx.status, WagerTransactionStatus.Pending);
    tx.markProcessed(undefined, new Date('2024-01-01T00:00:00Z'));
    assert.equal(tx.status, WagerTransactionStatus.Processed);
    assert.equal(tx.ledgerDirectionFor(), LedgerDirection.Debit);
  });

  it('Permite transições para referência pendente', () => {
    const tx = WagerTransaction.create({
      id: 't-2',
      providerId: 'provider-a',
      externalTransactionId: 'ext-2',
      idempotencyKey: 'key-2',
      payloadHash: 'hash-2',
      walletId: 'w-1',
      playerId: 'player-a',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '12.00', currency: 'BRL' },
      referenceExternalTransactionId: 'not-arrived-yet',
    });

    assert.equal(tx.status, WagerTransactionStatus.Pending);
    tx.markPendingReference();
    assert.equal(tx.status, WagerTransactionStatus.PendingReference);
    tx.reject(FailureCode.MissingReference);
    assert.equal(tx.isTerminal(), true);
    assert.equal(tx.failureCode, FailureCode.MissingReference);
  });

  it('Exige referência externa em REFUND e ROLLBACK e reserva OPENING para o fluxo interno', () => {
    const props = {
      id: 't-invalid',
      providerId: 'provider-a',
      externalTransactionId: 'ext-invalid',
      idempotencyKey: 'key-invalid',
      payloadHash: 'hash-invalid',
      walletId: 'w-1',
      playerId: 'player-a',
      roundId: 'round-1',
      gameId: 'game-1',
      money: { amount: '12.00', currency: 'BRL' },
    };

    assert.throws(() => WagerTransaction.create({ ...props, kind: WagerTransactionKind.Refund }));
    assert.throws(() => WagerTransaction.create({ ...props, kind: WagerTransactionKind.Opening }));
  });
});

describe('Lançamento do ledger da carteira', () => {
  it('Valida corretamente os saldos anterior e posterior', () => {
    const before = Money.from({ amount: '100.00', currency: 'BRL' });
    const after = Money.from({ amount: '105.00', currency: 'BRL' });
    const movement = Money.from({ amount: '5.00', currency: 'BRL' });

    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'w-1',
      transactionId: 't-1',
      direction: LedgerDirection.Credit,
      money: movement,
      balanceBefore: before,
      balanceAfter: after,
    });

    assert.equal(entry.isBalanced(), true);
  });
});

describe('Concorrência pelo saldo da carteira', () => {
  it('Simula uma aposta de R$ 80,00 aceita, outra rejeitada por saldo insuficiente e uma repetição duplicada', () => {
    const wallet = Wallet.open({
      id: 'wallet-competition',
      playerId: 'player-competition',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const betOne = WagerTransaction.create({
      id: 'bet-1',
      providerId: 'provider-1',
      externalTransactionId: 'ext-bet-1',
      idempotencyKey: 'idem-bet-1',
      payloadHash: 'hash-bet-1',
      walletId: wallet.id,
      playerId: 'player-competition',
      roundId: 'round-race',
      gameId: 'game-race',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    });

    const betTwo = WagerTransaction.create({
      id: 'bet-2',
      providerId: 'provider-1',
      externalTransactionId: 'ext-bet-2',
      idempotencyKey: 'idem-bet-2',
      payloadHash: 'hash-bet-2',
      walletId: wallet.id,
      playerId: 'player-competition',
      roundId: 'round-race',
      gameId: 'game-race',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    });

    const seen = new Map<string, WagerTransaction>();
    const ledgerEntries: WalletLedgerEntry[] = [];

    const applyBet = (transaction: WagerTransaction): WagerTransaction => {
      const duplicate = seen.get(transaction.idempotencyKey);
      if (duplicate) {
        return duplicate;
      }

      if (wallet.balance.isLessThan(transaction.money)) {
        transaction.reject(FailureCode.InsufficientFunds);
        seen.set(transaction.idempotencyKey, transaction);
        return transaction;
      }

      const balanceBefore = wallet.balance;
      wallet.debit(transaction.money);
      transaction.markProcessed(undefined, new Date('2024-02-01T00:00:00Z'));

      ledgerEntries.push(
        WalletLedgerEntry.create({
          id: `ledger-${transaction.id}`,
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: LedgerDirection.Debit,
          money: transaction.money,
          balanceBefore,
          balanceAfter: wallet.balance,
        }),
      );

      seen.set(transaction.idempotencyKey, transaction);
      return transaction;
    };

    const first = applyBet(betOne);
    const second = applyBet(betTwo);
    const replay = applyBet(betOne);

    const processedIds = new Set<string>();
    const rejectedIds = new Set<string>();

    for (const tx of [first, second, replay]) {
      if (tx.status === WagerTransactionStatus.Processed) {
        processedIds.add(tx.id);
      }
      if (tx.status === WagerTransactionStatus.Rejected) {
        rejectedIds.add(tx.id);
      }
    }

    assert.equal(processedIds.size, 1);
    assert.equal(rejectedIds.size, 1);
    assert.deepEqual(wallet.balance.toJSON(), { amount: '20.00', currency: 'BRL' });
    assert.equal(ledgerEntries.length, 1);
    assert.deepEqual(ledgerEntries[0].balanceBefore.toJSON(), { amount: '100.00', currency: 'BRL' });
    assert.deepEqual(ledgerEntries[0].balanceAfter.toJSON(), { amount: '20.00', currency: 'BRL' });
    assert.equal(replay.status, WagerTransactionStatus.Processed);
    assert.equal(wallet.version, 2);
  });
});
