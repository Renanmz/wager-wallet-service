import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FailureCode,
  LedgerDirection,
  Money,
  WagerRules,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
} from '../src/index.ts';

let transactionSequence = 0;

function makeTransaction(
  kind: WagerTransactionKind,
  amount: string,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  const sequence = ++transactionSequence;
  const props = {
    id: `tx-${sequence}`,
    providerId: 'provider-1',
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `key-${sequence}`,
    payloadHash: `hash-${sequence}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
  };

  return kind === WagerTransactionKind.Opening
    ? WagerTransaction.createOpening(props)
    : WagerTransaction.create(props);
}

function openWallet(balance: string): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
  });
}

function processedBet(amount: string): WagerTransaction {
  const bet = makeTransaction(WagerTransactionKind.Bet, amount);
  bet.markProcessed(undefined);
  return bet;
}

describe('Regras de aposta', () => {
  it('Debita BET, credita WIN e processa LOSS sem alterar a carteira nem o ledger', () => {
    const wallet = openWallet('100.00');
    const bet = makeTransaction(WagerTransactionKind.Bet, '25.00');
    const betResult = WagerRules.apply({ transaction: bet, wallet });
    assert.equal(betResult.status, WagerTransactionStatus.Processed);
    assert.equal(betResult.ledgerEntry?.direction, LedgerDirection.Debit);
    assert.deepEqual(wallet.balance.toJSON(), { amount: '75.00', currency: 'BRL' });

    const win = makeTransaction(WagerTransactionKind.Win, '10.00');
    const winResult = WagerRules.apply({ transaction: win, wallet });
    assert.equal(winResult.status, WagerTransactionStatus.Processed);
    assert.equal(winResult.ledgerEntry?.direction, LedgerDirection.Credit);
    assert.deepEqual(wallet.balance.toJSON(), { amount: '85.00', currency: 'BRL' });

    const versionBeforeLoss = wallet.version;
    const loss = makeTransaction(WagerTransactionKind.Loss, '5.00');
    const lossResult = WagerRules.apply({ transaction: loss, wallet });
    assert.equal(lossResult.status, WagerTransactionStatus.Processed);
    assert.equal(lossResult.ledgerEntry, undefined);
    assert.equal(wallet.version, versionBeforeLoss);
  });

  it('Rejeita BET com saldo insuficiente sem criar lançamento no ledger', () => {
    const wallet = openWallet('10.00');
    const bet = makeTransaction(WagerTransactionKind.Bet, '80.00');
    const result = WagerRules.apply({ transaction: bet, wallet });

    assert.equal(result.status, WagerTransactionStatus.Rejected);
    assert.equal(result.failureCode, FailureCode.InsufficientFunds);
    assert.equal(result.ledgerEntry, undefined);
    assert.deepEqual(wallet.balance.toJSON(), { amount: '10.00', currency: 'BRL' });
  });

  it('Aguarda referências ausentes e processa uma única vez um REFUND válido', () => {
    const wallet = openWallet('20.00');
    const refund = makeTransaction(WagerTransactionKind.Refund, '80.00', 'external-bet');
    const pending = WagerRules.apply({ transaction: refund, wallet });
    assert.equal(pending.status, WagerTransactionStatus.PendingReference);

    const bet = processedBet('80.00');
    const result = WagerRules.apply({ transaction: refund, wallet, reference: bet });
    assert.equal(result.status, WagerTransactionStatus.Processed);
    assert.equal(result.ledgerEntry?.direction, LedgerDirection.Credit);
    assert.deepEqual(wallet.balance.toJSON(), { amount: '100.00', currency: 'BRL' });

    const secondRefund = makeTransaction(WagerTransactionKind.Refund, '80.00', 'external-bet');
    const duplicate = WagerRules.apply({
      transaction: secondRefund,
      wallet,
      reference: bet,
      existingReversalKinds: [WagerTransactionKind.Refund],
    });
    assert.equal(duplicate.status, WagerTransactionStatus.Rejected);
    assert.equal(duplicate.failureCode, FailureCode.InvalidReference);
    assert.equal(duplicate.ledgerEntry, undefined);
  });

  it('ROLLBACK estorna uma BET processada e rejeita um estorno que deixaria o saldo negativo', () => {
    const wallet = openWallet('100.00');
    const bet = makeTransaction(WagerTransactionKind.Bet, '80.00');
    WagerRules.apply({ transaction: bet, wallet });

    const rollback = makeTransaction(WagerTransactionKind.Rollback, '80.00', bet.externalTransactionId);
    const rollbackResult = WagerRules.apply({ transaction: rollback, wallet, reference: bet });
    assert.equal(rollbackResult.status, WagerTransactionStatus.Processed);
    assert.equal(rollbackResult.ledgerEntry?.direction, LedgerDirection.Credit);
    assert.deepEqual(wallet.balance.toJSON(), { amount: '100.00', currency: 'BRL' });

    const secondWallet = openWallet('0.00');
    const win = makeTransaction(WagerTransactionKind.Win, '50.00');
    WagerRules.apply({ transaction: win, wallet: secondWallet });
    secondWallet.debit(Money.from({ amount: '50.00', currency: 'BRL' }));

    const rollbackWin = makeTransaction(WagerTransactionKind.Rollback, '50.00', win.externalTransactionId);
    const rejected = WagerRules.apply({ transaction: rollbackWin, wallet: secondWallet, reference: win });
    assert.equal(rejected.status, WagerTransactionStatus.Rejected);
    assert.equal(rejected.failureCode, FailureCode.ReversalInsufficientFunds);
    assert.equal(rejected.ledgerEntry, undefined);
  });

  it('Rejeita referências com contexto ou moeda incompatíveis', () => {
    const wallet = openWallet('100.00');
    const refund = makeTransaction(WagerTransactionKind.Refund, '20.00', 'external-bet');
    const reference = processedBet('20.00');
    const foreignReference = WagerTransaction.rehydrate({
      id: reference.id,
      providerId: 'another-provider',
      externalTransactionId: reference.externalTransactionId,
      idempotencyKey: reference.idempotencyKey,
      payloadHash: reference.payloadHash,
      walletId: reference.walletId,
      playerId: reference.playerId,
      roundId: reference.roundId,
      gameId: reference.gameId,
      kind: reference.kind,
      money: reference.money.toJSON(),
      createdAt: reference.createdAt,
      status: WagerTransactionStatus.Processed,
    });

    const invalidReference = WagerRules.apply({ transaction: refund, wallet, reference: foreignReference });
    assert.equal(invalidReference.failureCode, FailureCode.InvalidReference);

    const wrongCurrencyBet = makeTransaction(WagerTransactionKind.Bet, '5.00');
    const wrongCurrency = WagerTransaction.rehydrate({
      id: wrongCurrencyBet.id,
      providerId: wrongCurrencyBet.providerId,
      externalTransactionId: wrongCurrencyBet.externalTransactionId,
      idempotencyKey: wrongCurrencyBet.idempotencyKey,
      payloadHash: wrongCurrencyBet.payloadHash,
      walletId: wrongCurrencyBet.walletId,
      playerId: wrongCurrencyBet.playerId,
      roundId: wrongCurrencyBet.roundId,
      gameId: wrongCurrencyBet.gameId,
      kind: wrongCurrencyBet.kind,
      money: { amount: '5.00', currency: 'USD' },
      createdAt: wrongCurrencyBet.createdAt,
      status: WagerTransactionStatus.Pending,
    });
    const currencyResult = WagerRules.apply({ transaction: wrongCurrency, wallet });
    assert.equal(currencyResult.failureCode, FailureCode.IncompatibleCurrency);
    assert.equal(wallet.balance.toJSON().amount, '100.00');
  });
});
