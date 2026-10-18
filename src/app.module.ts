import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from '../mikro-orm.config.ts';
import { WalletApplicationService } from './application/services/wallet-application.service.ts';
import { WalletController } from './http/wallet.controller.ts';
import { WagerController } from './http/wager.controller.ts';
import { WagerApplicationService } from './application/services/wager-application.service.ts';
import { HealthController } from './http/health.controller.ts';
import { MetricsController } from './http/metrics.controller.ts';
import { SqsAdapter } from './infrastructure/messaging/sqs.adapter.ts';
import { MetricsService } from './observability/metrics.service.ts';
import { WagerQueueConsumer } from './workers/wager-queue-consumer.ts';
import { OutboxPublisher } from './workers/outbox-publisher.ts';
import { PendingReferenceWorker } from './workers/pending-reference.worker.ts';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [WalletController, WagerController, HealthController, MetricsController],
  providers: [
    WalletApplicationService,
    WagerApplicationService,
    SqsAdapter,
    MetricsService,
    WagerQueueConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
  ],
})
export class AppModule {}
