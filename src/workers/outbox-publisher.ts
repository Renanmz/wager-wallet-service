import { EntityManager } from '@mikro-orm/core';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SqsAdapter } from '../infrastructure/messaging/sqs.adapter.ts';
import { MetricsService } from '../observability/metrics.service.ts';
import { executeInTransaction } from '../infrastructure/persistence/execute-in-transaction.ts';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly publisherId = randomUUID();
  private running = false;
  private loopTask?: Promise<void>;

  constructor(
    private readonly entityManager: EntityManager,
    private readonly sqs: SqsAdapter,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.ENABLE_OUTBOX_PUBLISHER === 'true') {
      this.running = true;
      this.loopTask = this.run();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loopTask;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.publishDueBatch();
        await this.updateOutboxLag();
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'outbox_publisher_cycle_failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }));
      }
      await delay(1000);
    }
  }

  private async publishDueBatch(): Promise<void> {
    const rows = await this.entityManager.transactional(async (em) => {
      const claimed = await executeInTransaction<OutboxRow[]>(
        em,
        `with due as (
           select id
           from outbox_messages
           where published_at is null
             and coalesce(next_attempt_at, created_at) <= now()
             and (locked_until is null or locked_until < now())
           order by coalesce(next_attempt_at, created_at), created_at, id
           for update skip locked
           limit 25
         )
         update outbox_messages o
         set locked_by = ?, locked_until = now() + interval '60 seconds', attempts = attempts + 1
         from due
         where o.id = due.id
         returning o.id, o.aggregate_id, o.payload, o.attempts`,
        [this.publisherId],
      );
      return claimed as OutboxRow[];
    });

    await Promise.all(rows.map((row) => this.publishOne(row)));
  }

  private async publishOne(row: OutboxRow): Promise<void> {
    const body = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
    try {
      await this.sqs.publish(body, row.aggregate_id, row.id);
      await this.entityManager.getConnection().execute(
        `update outbox_messages
         set published_at = now(), locked_by = null, locked_until = null, next_attempt_at = null
         where id = ? and locked_by = ? and published_at is null`,
        [row.id, this.publisherId],
      );
    } catch (error) {
      const backoffMs = Math.min(1000 * (2 ** Math.min(Number(row.attempts) - 1, 18)), 300_000);
      await this.entityManager.getConnection().execute(
        `update outbox_messages
         set next_attempt_at = now() + (? * interval '1 millisecond'),
             locked_by = null, locked_until = null
         where id = ? and locked_by = ? and published_at is null`,
        [backoffMs, row.id, this.publisherId],
      );
      console.error(JSON.stringify({
        level: 'error',
        event: 'outbox_event_publish_failed',
        eventId: row.id,
        aggregateId: row.aggregate_id,
        attempts: row.attempts,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }));
    }
  }

  private async updateOutboxLag(): Promise<void> {
    const rows = await this.entityManager.getConnection().execute<Array<{ lag_seconds: string | number | null }>>(
      `select coalesce(extract(epoch from (now() - min(created_at))), 0)::text as lag_seconds
       from outbox_messages where published_at is null`,
    );
    this.metrics.setOutboxLagSeconds(Number(rows[0]?.lag_seconds ?? 0));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
