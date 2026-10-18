import { EventContext, IntegrationEvent } from './integration-event.ts';
import { WagerTransaction } from '../wager-transaction.ts';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    if (!transaction.failureCode) {
      throw new Error('Rejected transactions must have a failure code.');
    }

    return new WagerTransactionRejected({
      aggregateId: transaction.walletId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        failureCode: transaction.failureCode,
      },
    });
  }
}
