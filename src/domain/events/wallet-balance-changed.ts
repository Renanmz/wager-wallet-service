import { EventContext, IntegrationEvent } from './integration-event.ts';
import { MoneyProps } from '../money.ts';
import { WagerTransaction } from '../wager-transaction.ts';
import { WalletLedgerEntry } from '../wallet-ledger-entry.ts';
import { Wallet } from '../wallet.ts';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    transaction: WagerTransaction,
    context: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      aggregateId: wallet.id,
      correlationId: context.correlationId,
      causationId: context.causationId ?? transaction.id,
      occurredAt: context.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
