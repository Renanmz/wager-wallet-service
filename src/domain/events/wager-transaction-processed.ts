import { EventContext, IntegrationEvent } from './integration-event.ts';
import { MoneyProps } from '../money.ts';
import { WagerTransaction } from '../wager-transaction.ts';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  status: 'PROCESSED';
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      aggregateId: transaction.walletId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        status: 'PROCESSED',
      },
    });
  }
}
