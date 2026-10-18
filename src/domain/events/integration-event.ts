import { randomUUID } from 'node:crypto';

export interface IntegrationEventProps<T> {
  eventId?: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
  data: T;
}

export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId ?? randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt ?? Date.now());
    this.data = deepFreeze(structuredClone(props.data));
  }

  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
  } {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data) as T,
    };
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
