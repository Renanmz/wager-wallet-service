import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly processingDurations: number[] = [];
  private outboxLagSeconds = 0;

  transaction(status: string): void {
    this.increment(`wager_transactions_total{status="${safeLabel(status)}"}`);
  }

  duplicate(): void {
    this.increment('wager_idempotent_duplicates_total');
  }

  retry(): void {
    this.increment('queue_retries_total');
  }

  deadLetter(): void {
    this.increment('queue_dead_letters_total');
  }

  lockConflict(): void {
    this.increment('wallet_lock_conflicts_total');
  }

  reconciliationMismatch(): void {
    this.increment('wallet_reconciliation_mismatches_total');
  }

  processingLatency(milliseconds: number): void {
    this.processingDurations.push(milliseconds);
    if (this.processingDurations.length > 1000) {
      this.processingDurations.shift();
    }
  }

  setOutboxLagSeconds(seconds: number): void {
    this.outboxLagSeconds = Math.max(0, seconds);
  }

  render(): string {
    const lines = [
      '# TYPE wager_transactions_total counter',
      ...[...this.counters.entries()]
        .filter(([name]) => name.startsWith('wager_transactions_total'))
        .map(([name, value]) => `${name} ${value}`),
      '# TYPE wager_idempotent_duplicates_total counter',
      `wager_idempotent_duplicates_total ${this.value('wager_idempotent_duplicates_total')}`,
      '# TYPE queue_retries_total counter',
      `queue_retries_total ${this.value('queue_retries_total')}`,
      '# TYPE queue_dead_letters_total counter',
      `queue_dead_letters_total ${this.value('queue_dead_letters_total')}`,
      '# TYPE wallet_lock_conflicts_total counter',
      `wallet_lock_conflicts_total ${this.value('wallet_lock_conflicts_total')}`,
      '# TYPE wallet_reconciliation_mismatches_total counter',
      `wallet_reconciliation_mismatches_total ${this.value('wallet_reconciliation_mismatches_total')}`,
      '# TYPE outbox_lag_seconds gauge',
      `outbox_lag_seconds ${this.outboxLagSeconds}`,
      '# TYPE wager_processing_latency_milliseconds summary',
      `wager_processing_latency_milliseconds_count ${this.processingDurations.length}`,
      `wager_processing_latency_milliseconds_sum ${this.processingDurations.reduce((sum, item) => sum + item, 0)}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  private increment(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  private value(name: string): number {
    return this.counters.get(name) ?? 0;
  }
}

function safeLabel(value: string): string {
  return value.replace(/[^A-Z_]/gi, '_');
}
