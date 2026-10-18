import { EntityManager } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { ApplicationError } from '../errors.ts';
import { canonicalJson } from '../idempotency/wager-payload-hash.ts';
import { EventContext } from '../../domain/events/integration-event.ts';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.ts';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.ts';
import { Money, MoneyProps } from '../../domain/money.ts';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction.ts';
import { Wallet } from '../../domain/wallet.ts';
import { MetricsService } from '../../observability/metrics.service.ts';
import { executeInTransaction } from '../../infrastructure/persistence/execute-in-transaction.ts';

interface SqlRow {
  [key: string]: unknown;
}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

@Injectable()
export class WalletApplicationService {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly metrics: MetricsService,
  ) {}

  async createWallet(input: CreateWalletInput, correlationId: string): Promise<Record<string, unknown>> {
    const initialBalance = Money.from(input.initialBalance);
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      initialBalance,
    });

    try {
      return await this.entityManager.transactional(async (em) => {
        await executeInTransaction(
          em,
          `insert into wallets (id, player_id, currency, balance, version)
           values (?, ?, ?, ?, 1)`,
          [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toString()],
        );

        if (initialBalance.isPositive()) {
          const now = new Date();
          const openingId = randomUUID();
          const opening = WagerTransaction.createOpening({
            id: openingId,
            providerId: 'INTERNAL',
            externalTransactionId: `OPENING:${wallet.id}`,
            idempotencyKey: `OPENING:${wallet.id}`,
            payloadHash: createHash('sha256').update(canonicalJson({
              walletId: wallet.id,
              amount: initialBalance.toJSON(),
            })).digest('hex'),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'wallet-opening',
            gameId: 'internal',
            kind: WagerTransactionKind.Opening,
            money: initialBalance.toJSON(),
            createdAt: now,
          });
          opening.markProcessed(undefined, now);
          await executeInTransaction(
            em,
            `insert into wager_transactions
               (id, provider_id, correlation_id, external_transaction_id, idempotency_key, payload_hash,
                wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
                created_at, processed_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPENING', ?, ?, 'PROCESSED', ?, ?)`,
            [
              opening.id,
              opening.providerId,
              correlationId,
              opening.externalTransactionId,
              opening.idempotencyKey,
              opening.payloadHash,
              opening.walletId,
              opening.playerId,
              opening.roundId,
              opening.gameId,
              opening.money.toString(),
              opening.money.currency,
              now,
              now,
            ],
          );

          const entry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: initialBalance,
            createdAt: now,
          });
          await this.insertLedgerEntry(em, entry);

          const context: EventContext = { correlationId, occurredAt: now };
          await this.insertOutbox(em, WagerTransactionProcessed.from(opening, context));
          await this.insertOutbox(em, WalletBalanceChanged.from(wallet, entry, opening, context));
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (isPostgresCode(error, '23505')) {
        throw new ApplicationError(409, 'WALLET_ALREADY_EXISTS', 'A wallet already exists for this player and currency.');
      }
      throw error;
    }
  }

  async getWallet(walletId: string): Promise<Record<string, unknown>> {
    const rows = await this.entityManager.getConnection().execute<SqlRow[]>(
      `select id, player_id, currency, balance::text as balance, version
       from wallets where id = ?`,
      [walletId],
    );
    const row = rows[0];
    if (!row) {
      throw new ApplicationError(404, 'WALLET_NOT_FOUND', 'Wallet was not found.');
    }
    return {
      id: row.id,
      playerId: row.player_id,
      balance: { amount: formatAmount(row.balance), currency: row.currency },
      version: row.version,
    };
  }

  async getLedger(
    walletId: string,
    cursor: string | undefined,
    requestedLimit: number | undefined,
  ): Promise<Record<string, unknown>> {
    const limit = requestedLimit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError(400, 'INVALID_LIMIT', 'Ledger limit must be an integer between 1 and 100.');
    }

    const exists = await this.entityManager.getConnection().execute<SqlRow[]>(
      'select id from wallets where id = ?',
      [walletId],
    );
    if (!exists[0]) {
      throw new ApplicationError(404, 'WALLET_NOT_FOUND', 'Wallet was not found.');
    }

    const decodedCursor = cursor ? decodeCursor(cursor) : undefined;
    const params: unknown[] = [walletId];
    let cursorClause = '';
    if (decodedCursor) {
      cursorClause = 'and (created_at, id) < (?, ?::uuid)';
      params.push(decodedCursor.createdAt, decodedCursor.id);
    }
    params.push(limit + 1);

    const rows = await this.entityManager.getConnection().execute<SqlRow[]>(
      `select id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after, created_at
       from wallet_ledger_entries
       where wallet_id = ? ${cursorClause}
       order by created_at desc, id desc
       limit ?`,
      params,
    );
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((row: SqlRow) => ({
      id: row.id,
      transactionId: row.transaction_id,
      direction: row.direction,
      money: { amount: formatAmount(row.amount), currency: row.currency },
      balanceBefore: { amount: formatAmount(row.balance_before), currency: row.currency },
      balanceAfter: { amount: formatAmount(row.balance_after), currency: row.currency },
      createdAt: new Date(String(row.created_at)).toISOString(),
    }));
    const last = rows[Math.min(rows.length, limit) - 1];

    return {
      entries,
      nextCursor: hasMore && last
        ? encodeCursor(new Date(String(last.created_at)).toISOString(), String(last.id))
        : null,
    };
  }

  async reconcile(walletId: string, correlationId: string): Promise<Record<string, unknown>> {
    const rows = await this.entityManager.getConnection().execute<SqlRow[]>(
      `select w.balance::text as stored_balance,
              w.currency,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text
                as calculated_balance,
              count(l.id)::text as checked_entries
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
       where w.id = ?
       group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) {
      throw new ApplicationError(404, 'WALLET_NOT_FOUND', 'Wallet was not found.');
    }

    const currency = String(row.currency).trim();
    const storedBalance = Money.from({ amount: formatAmount(row.stored_balance), currency });
    const calculatedBalance = Money.from({ amount: formatAmount(row.calculated_balance), currency });
    const difference = storedBalance.subtract(calculatedBalance);
    const checkedEntries = Number(row.checked_entries);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.reconciliationMismatch();
      console.warn(JSON.stringify({
        level: 'error',
        event: 'wallet_reconciliation_mismatch',
        correlationId,
        walletId,
        checkedEntries,
        currency,
      }));
    }

    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries,
    };
  }

  private async insertLedgerEntry(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await executeInTransaction(
      em,
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.createdAt,
      ],
    );
  }

  private async insertOutbox<T>(em: EntityManager, event: import('../../domain/events/integration-event.ts').IntegrationEvent<T>): Promise<void> {
    await executeInTransaction(
      em,
      `insert into outbox_messages
         (id, aggregate_id, event_type, event_version, payload, occurred_at)
       values (?, ?, ?, ?, ?::jsonb, ?)`,
      [
        event.eventId,
        event.aggregateId,
        event.eventType,
        event.version,
        JSON.stringify(event.toJSON()),
        event.occurredAt,
      ],
    );
  }
}

function formatAmount(value: unknown): string {
  const amount = String(value);
  return amount.includes('.') ? amount.padEnd(amount.indexOf('.') + 3, '0') : `${amount}.00`;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof decoded !== 'object'
      || decoded === null
      || !('createdAt' in decoded)
      || !('id' in decoded)
      || typeof decoded.createdAt !== 'string'
      || Number.isNaN(Date.parse(decoded.createdAt))
      || typeof decoded.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.id)
    ) {
      throw new Error('Invalid cursor shape.');
    }
    return { createdAt: new Date(decoded.createdAt).toISOString(), id: decoded.id };
  } catch {
    throw new ApplicationError(400, 'INVALID_CURSOR', 'Ledger cursor is invalid.');
  }
}

function isPostgresCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}
