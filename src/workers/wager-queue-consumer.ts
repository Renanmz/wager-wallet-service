import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Type, plainToInstance } from 'class-transformer';
import {
  Equals,
  IsDateString,
  IsNotEmpty,
  IsString,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { WagerApplicationService } from '../application/services/wager-application.service.ts';
import { ApplicationError } from '../application/errors.ts';
import { hashWagerPayload } from '../application/idempotency/wager-payload-hash.ts';
import { SqsAdapter } from '../infrastructure/messaging/sqs.adapter.ts';
import { MetricsService } from '../observability/metrics.service.ts';
import { SubmitWagerTransactionDto } from '../http/request.dto.ts';

class QueueWagerDataDto extends SubmitWagerTransactionDto {
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}

class WagerQueueEnvelopeDto {
  @IsString()
  @IsNotEmpty()
  messageId!: string;

  @Equals('WagerTransactionRequested')
  type!: string;

  @IsDateString()
  occurredAt!: string;

  @ValidateNested()
  @Type(() => QueueWagerDataDto)
  data!: QueueWagerDataDto;
}

interface ReceivedMessage {
  Body?: string;
  ReceiptHandle?: string;
  Attributes?: Record<string, string>;
  MessageId?: string;
}

@Injectable()
export class WagerQueueConsumer implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loopTask?: Promise<void>;
  private abortController?: AbortController;
  private readonly inFlightReceipts = new Set<string>();

  constructor(
    private readonly sqs: SqsAdapter,
    private readonly wagers: WagerApplicationService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.ENABLE_WAGER_CONSUMER === 'true') {
      this.running = true;
      this.loopTask = this.run();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    if (!this.loopTask) return;
    const completed = await Promise.race([
      this.loopTask.then(() => true),
      delay(25_000).then(() => false),
    ]);
    if (!completed) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'wager_consumer_shutdown_visibility_return',
        inFlightCount: this.inFlightReceipts.size,
      }));
      await Promise.allSettled(
        [...this.inFlightReceipts].map((receipt) => this.sqs.changeVisibility(receipt, 0)),
      );
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.abortController = new AbortController();
      try {
        const result = await this.sqs.receive(this.abortController.signal);
        const messages = (result.Messages ?? []) as ReceivedMessage[];
        await Promise.all(messages.map(async (message) => {
          if (message.ReceiptHandle) this.inFlightReceipts.add(message.ReceiptHandle);
          try {
            await this.process(message);
          } finally {
            if (message.ReceiptHandle) this.inFlightReceipts.delete(message.ReceiptHandle);
          }
        }));
      } catch (error) {
        if (isAbortError(error) && !this.running) {
          break;
        }
        this.logFailure(error);
        await delay(1000);
      }
    }
  }

  private async process(message: ReceivedMessage): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    if (!receiptHandle) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'sqs_message_without_receipt_handle',
        messageId: message.MessageId,
      }));
      return;
    }

    const startedAt = Date.now();
    let envelope: WagerQueueEnvelopeDto | undefined;
    try {
      if (!message.Body) {
        throw new ApplicationError(400, 'EMPTY_QUEUE_MESSAGE', 'Queue message body is empty.');
      }
      const body: unknown = JSON.parse(message.Body);
      envelope = plainToInstance(WagerQueueEnvelopeDto, body);
      const validationErrors = validateSync(envelope, { whitelist: true, forbidNonWhitelisted: true });
      if (validationErrors.length > 0) {
        throw new ApplicationError(400, 'INVALID_QUEUE_MESSAGE', 'Queue message does not match the wager event contract.');
      }

      const payloadHash = hashWagerPayload(envelope.data);
      const result = await this.wagers.submit(
        envelope.data,
        envelope.data.idempotencyKey,
        {
          correlationId: envelope.messageId,
          causationId: envelope.messageId,
          occurredAt: new Date(envelope.occurredAt),
        },
        {
          consumerName: 'wager-transactions-worker',
          messageId: envelope.messageId,
          payloadHash,
        },
      );

      this.metrics.transaction(result.body.status);
      if (result.body.idempotentReplay) {
        this.metrics.duplicate();
      }
      if (!this.running) {
        await this.sqs.changeVisibility(receiptHandle, 0);
        return;
      }
      await this.sqs.acknowledge(receiptHandle);
      this.metrics.processingLatency(Date.now() - startedAt);
    } catch (error) {
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      this.metrics.retry();
      if (receiveCount >= 5) {
        this.metrics.deadLetter();
      }
      console.error(JSON.stringify({
        level: 'error',
        event: 'wager_queue_message_failed',
        messageId: envelope?.messageId ?? message.MessageId,
        providerId: envelope?.data.providerId,
        transactionId: envelope?.data.externalTransactionId,
        receiveCount,
        errorCode: error instanceof ApplicationError ? error.code : 'TRANSIENT_PROCESSING_ERROR',
      }));
      const visibility = Math.min(2 ** Math.max(receiveCount - 1, 0), 60);
      await this.sqs.changeVisibility(receiptHandle, visibility);
    }
  }

  private logFailure(error: unknown): void {
    console.error(JSON.stringify({
      level: 'error',
      event: 'wager_queue_poll_failed',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }));
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
