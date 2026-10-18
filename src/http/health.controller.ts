import { Controller, Get, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { SqsAdapter } from '../infrastructure/messaging/sqs.adapter.ts';

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsAdapter,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res() response: HttpResponse): Promise<void> {
    try {
      await this.orm.em.getConnection().execute('select 1');
      await this.sqs.isReady();
      response.status(200).json({ status: 'ready' });
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'readiness_check_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }));
      response.status(503).json({ status: 'not_ready', code: 'DEPENDENCY_UNAVAILABLE' });
    }
  }
}
