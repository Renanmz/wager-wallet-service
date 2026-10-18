import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class SqsAdapter implements OnModuleDestroy {
  readonly client: SQSClient;
  readonly wagerQueueUrl: string;
  readonly outboxQueueUrl: string;
  readonly deadLetterQueueUrl: string;

  constructor() {
    const endpoint = process.env.SQS_ENDPOINT;
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      ...(endpoint
        ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
        : {}),
    });
    const localEndpoint = endpoint ?? 'http://localhost:4566';
    this.wagerQueueUrl = process.env.WAGER_QUEUE_URL
      ?? `${localEndpoint}/000000000000/wager-transactions.fifo`;
    this.outboxQueueUrl = process.env.OUTBOX_QUEUE_URL
      ?? `${localEndpoint}/000000000000/integration-events.fifo`;
    this.deadLetterQueueUrl = process.env.WAGER_DLQ_URL
      ?? `${localEndpoint}/000000000000/wager-transactions-dlq.fifo`;
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async isReady(): Promise<boolean> {
    await Promise.all([
      this.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.wagerQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      })),
      this.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.outboxQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      })),
    ]);
    return true;
  }

  receive(signal?: AbortSignal) {
    return this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.wagerQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 60,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      MessageAttributeNames: ['All'],
    }), { abortSignal: signal });
  }

  acknowledge(receiptHandle: string) {
    return this.client.send(new DeleteMessageCommand({
      QueueUrl: this.wagerQueueUrl,
      ReceiptHandle: receiptHandle,
    }));
  }

  changeVisibility(receiptHandle: string, visibilityTimeout: number) {
    return this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.wagerQueueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: visibilityTimeout,
    }));
  }

  publish(body: string, aggregateId: string, eventId: string) {
    return this.client.send(new SendMessageCommand({
      QueueUrl: this.outboxQueueUrl,
      MessageBody: body,
      MessageGroupId: aggregateId,
      MessageDeduplicationId: eventId,
    }));
  }

  async queueDepth(queueUrl: string): Promise<number> {
    const result = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }));
    return Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
  }
}
