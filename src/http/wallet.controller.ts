import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { WalletApplicationService } from '../application/services/wallet-application.service.ts';
import { ApplicationError } from '../application/errors.ts';
import { CreateWalletDto } from './request.dto.ts';


@Controller('wallets')
export class WalletController {
  constructor(private readonly wallets: WalletApplicationService) {}

  @Post()
  async create(
    @Body() body: CreateWalletDto,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.wallets.createWallet(body, correlationId || randomUUID());
    response.status(201).json(result);
  }

  @Get(':walletId')
  getWallet(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<Record<string, unknown>> {
    return this.wallets.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  getLedger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<Record<string, unknown>> {
    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit)) {
        throw new ApplicationError(400, 'INVALID_LIMIT', 'Ledger limit must be an integer between 1 and 100.');
      }
    }
    return this.wallets.getLedger(walletId, cursor, parsedLimit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<Record<string, unknown>> {
    return this.wallets.reconcile(walletId, correlationId || randomUUID());
  }
}
