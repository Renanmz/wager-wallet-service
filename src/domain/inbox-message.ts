import { DomainValidationError } from './errors.ts';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date | string;
  processedAt?: Date | string;
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date | string;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName || !props.payloadHash) {
      throw new DomainValidationError('Inbox message identity is required.');
    }

    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(props.receivedAt ?? Date.now()),
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return Boolean(this._processedAt);
  }

  markProcessed(at: Date = new Date()): void {
    this._processedAt = at;
  }
}
