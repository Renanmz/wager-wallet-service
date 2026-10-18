import { randomUUID } from 'node:crypto';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.ts';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.ts';
import { Wallet } from './wallet.ts';

export interface ApplyWagerResult {
  status: WagerTransactionStatus;
  ledgerEntry?: WalletLedgerEntry;
  failureCode?: FailureCode;
}

export interface ApplyWagerOptions {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference?: WagerTransaction;
  existingReversalKinds?: readonly WagerTransactionKind[];
  now?: Date;
}

export class WagerRules {
  static apply(options: ApplyWagerOptions): ApplyWagerResult {
    const { transaction, wallet } = options;
    if (transaction.isTerminal()) {
      return { status: transaction.status, failureCode: transaction.failureCode };
    }

    if (
      transaction.walletId !== wallet.id
      || transaction.playerId !== wallet.playerId
    ) {
      return reject(transaction, FailureCode.InvalidReference);
    }

    if (transaction.money.currency !== wallet.currency) {
      return reject(transaction, FailureCode.IncompatibleCurrency);
    }

    let reference: WagerTransaction | undefined;
    const hasOptionalWinReference = transaction.kind === WagerTransactionKind.Win
      && transaction.referenceExternalTransactionId !== undefined;
    if (transaction.requiresReference() || hasOptionalWinReference) {
      if (!options.reference) {
        transaction.markPendingReference();
        return { status: transaction.status };
      }

      reference = options.reference;
      if (reference.status !== WagerTransactionStatus.Processed) {
        if (
          reference.status === WagerTransactionStatus.Pending
          || reference.status === WagerTransactionStatus.PendingReference
        ) {
          transaction.markPendingReference();
          return { status: transaction.status };
        }
        return reject(transaction, FailureCode.InvalidReference);
      }

      if (
        reference.providerId !== transaction.providerId
        || reference.playerId !== transaction.playerId
        || reference.walletId !== transaction.walletId
        || reference.roundId !== transaction.roundId
        || reference.money.currency !== transaction.money.currency
      ) {
        return reject(transaction, FailureCode.InvalidReference);
      }

      const validReferenceKind = transaction.kind === WagerTransactionKind.Refund
        ? reference.kind === WagerTransactionKind.Bet
        : transaction.kind === WagerTransactionKind.Rollback
          ? reference.kind === WagerTransactionKind.Bet
            || reference.kind === WagerTransactionKind.Win
            || reference.kind === WagerTransactionKind.Refund
          : reference.kind === WagerTransactionKind.Bet;
      if (!validReferenceKind) {
        return reject(transaction, FailureCode.InvalidReference);
      }

      if (
        transaction.kind !== WagerTransactionKind.Win
        && !reference.money.equals(transaction.money)
      ) {
        return reject(transaction, FailureCode.InvalidReference);
      }

      if (options.existingReversalKinds?.includes(transaction.kind)) {
        return reject(transaction, FailureCode.InvalidReference);
      }
    }

    if (transaction.kind === WagerTransactionKind.Loss) {
      transaction.markProcessed(reference?.id, options.now);
      return { status: transaction.status };
    }

    const direction = transaction.ledgerDirectionFor(reference);
    if (!direction) {
      return reject(transaction, FailureCode.InvalidReference);
    }

    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(transaction.money)) {
      const failureCode = transaction.kind === WagerTransactionKind.Rollback
        ? FailureCode.ReversalInsufficientFunds
        : FailureCode.InsufficientFunds;
      return reject(transaction, failureCode);
    }

    const balanceBefore = wallet.balance;
    if (direction === LedgerDirection.Credit) {
      wallet.credit(transaction.money);
    } else {
      wallet.debit(transaction.money);
    }

    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction,
      money: transaction.money,
      balanceBefore,
      balanceAfter: wallet.balance,
      createdAt: options.now,
    });
    transaction.markProcessed(reference?.id, options.now);

    return { status: transaction.status, ledgerEntry: entry };
  }
}

function reject(transaction: WagerTransaction, code: FailureCode): ApplyWagerResult {
  transaction.reject(code);
  return { status: transaction.status, failureCode: code };
}
