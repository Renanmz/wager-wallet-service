import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WagerApplicationService } from '../application/services/wager-application.service.ts';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loopTask?: Promise<void>;

  constructor(private readonly wagers: WagerApplicationService) {}

  onModuleInit(): void {
    if (process.env.ENABLE_REFERENCE_RETRY === 'true') {
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
        await this.wagers.processDueReferences();
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'pending_reference_retry_failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }));
      }
      await delay(1000);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
