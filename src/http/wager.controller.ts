import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../application/errors.ts';
import { WagerApplicationService } from '../application/services/wager-application.service.ts';
import { SubmitWagerTransactionDto } from './request.dto.ts';

@Controller()
export class WagerController {
  constructor(private readonly wagers: WagerApplicationService) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: SubmitWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (!idempotencyKey?.trim()) {
      throw new ApplicationError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required.');
    }
    const result = await this.wagers.submit(
      body,
      idempotencyKey,
      { correlationId: correlationId || randomUUID() },
    );
    response.status(result.httpStatus).json(result.body);
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId', ParseUUIDPipe) transactionId: string): Promise<Record<string, unknown>> {
    return this.wagers.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    return this.wagers.getByProviderExternalId(providerId, externalTransactionId);
  }
}
