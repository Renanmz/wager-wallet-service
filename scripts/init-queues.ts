import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const endpoint = process.env.SQS_ENDPOINT;
if (!endpoint) {
  throw new Error('SQS_ENDPOINT is required to initialize local queues.');
}

const client = new SQSClient({
  endpoint,
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});

try {
  await initializeQueues();
  console.info(JSON.stringify({ level: 'info', event: 'sqs_queues_initialized' }));
} finally {
  client.destroy();
}

async function initializeQueues(): Promise<void> {
  const deadLetterQueueUrl = await retryUntilLocalStackIsReady(async () => {
    const result = await client.send(new CreateQueueCommand({
      QueueName: 'wager-transactions-dlq.fifo',
      Attributes: { FifoQueue: 'true' },
    }));
    if (!result.QueueUrl) {
      throw new Error('LocalStack did not return a URL for the wager DLQ.');
    }
    return result.QueueUrl;
  });

  const deadLetterAttributes = await retryUntilLocalStackIsReady(() => client.send(
    new GetQueueAttributesCommand({
      QueueUrl: deadLetterQueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  ));
  const deadLetterArn = deadLetterAttributes.Attributes?.QueueArn;
  if (!deadLetterArn) {
    throw new Error('LocalStack did not return an ARN for the wager DLQ.');
  }

  await retryUntilLocalStackIsReady(() => client.send(new CreateQueueCommand({
    QueueName: 'wager-transactions.fifo',
    Attributes: {
      FifoQueue: 'true',
      VisibilityTimeout: '60',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: deadLetterArn,
        maxReceiveCount: '5',
      }),
    },
  })));

  await retryUntilLocalStackIsReady(() => client.send(new CreateQueueCommand({
    QueueName: 'integration-events.fifo',
    Attributes: { FifoQueue: 'true' },
  })));
}

async function retryUntilLocalStackIsReady<T>(operation: () => Promise<T>): Promise<T> {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error) || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('LocalStack queue initialization exhausted its retry limit.');
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    $metadata?: { httpStatusCode?: number };
    cause?: { code?: string };
    code?: string;
  };
  const status = candidate.$metadata?.httpStatusCode;
  if (status !== undefined && status >= 500) {
    return true;
  }
  const code = candidate.code ?? candidate.cause?.code;
  return code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'EAI_AGAIN';
}
