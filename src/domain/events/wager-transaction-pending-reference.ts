import { EventContext, IntegrationEvent } from './integration-event.ts';
import { WagerTransaction } from '../wager-transaction.ts';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId) {
      throw new Error('Pending reference transactions must identify their external reference.');
    }

    return new WagerTransactionPendingReference({
      aggregateId: transaction.walletId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}
