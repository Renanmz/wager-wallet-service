import { DomainValidationError } from './errors.ts';
import { IntegrationEvent } from './events/integration-event.ts';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date | string;
  attempts: number;
  nextAttemptAt?: Date | string;
  publishedAt?: Date | string;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue<T>(event: IntegrationEvent<T>): OutboxMessage {
    if (!event.eventType || !event.aggregateId) {
      throw new DomainValidationError('Outbox event type and aggregateId are required.');
    }

    const occurredAt = new Date(event.occurredAt);

    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...event.toJSON() }),
      occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      new Date(state.occurredAt),
      Number(state.attempts) || 0,
      state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined,
      state.publishedAt ? new Date(state.publishedAt) : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this._nextAttemptAt) {
      return true;
    }
    return now >= this._nextAttemptAt;
  }

  markPublished(at: Date = new Date()): void {
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const baseMs = 1000 * 60;
    const backoffMs = baseMs * Math.pow(2, Math.max(this._attempts - 1, 0));
    this._nextAttemptAt = new Date(now.getTime() + backoffMs);
  }
}
