import { EntityManager } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../errors.ts';
import { WagerBusinessPayload, hashWagerPayload } from '../idempotency/wager-payload-hash.ts';
import { EventContext, IntegrationEvent } from '../../domain/events/integration-event.ts';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference.ts';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.ts';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.ts';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.ts';
import { Money } from '../../domain/money.ts';
import { WagerRules } from '../../domain/wager-rules.ts';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionState,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.ts';
import { Wallet } from '../../domain/wallet.ts';
import { MetricsService } from '../../observability/metrics.service.ts';
import { executeInTransaction } from '../../infrastructure/persistence/execute-in-transaction.ts';

interface SqlRow {
  [key: string]: unknown;
}

export interface SubmitWagerInput extends WagerBusinessPayload {}

export interface SubmitWagerResult {
  httpStatus: number;
  body: {
    transactionId: string;
    status: WagerTransactionStatus;
    balance: { amount: string; currency: string };
    idempotentReplay: boolean;
    failureCode?: FailureCode;
  };
}

@Injectable()
export class WagerApplicationService {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly metrics: MetricsService,
  ) {}

  async submit(
    input: SubmitWagerInput,
    idempotencyKey: string,
    context: EventContext,
    inbox?: { consumerName: string; messageId: string; payloadHash: string },
  ): Promise<SubmitWagerResult> {
    const occurredAt = context.occurredAt ?? new Date();
    const eventContext: EventContext = {
      ...context,
      occurredAt,
    };
    if (!idempotencyKey.trim()) {
      throw new ApplicationError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required.');
    }

    const payloadHash = hashWagerPayload(input);
    return this.entityManager.transactional(async (em) => {
      await executeInTransaction(
        em,
        'select pg_advisory_xact_lock(hashtextextended(?, 0))',
        [JSON.stringify([input.providerId, idempotencyKey])],
      );

      let inboxAlreadyProcessed = false;
      if (inbox) {
        const inboxRows = await executeInTransaction<SqlRow[]>(
          em,
          `insert into inbox_messages (consumer_name, message_id, payload_hash)
           values (?, ?, ?)
           on conflict (consumer_name, message_id) do nothing
           returning message_id`,
          [inbox.consumerName, inbox.messageId, inbox.payloadHash],
        );

        if (inboxRows.length === 0) {
          const existingInbox = await executeInTransaction<SqlRow[]>(
            em,
            `select payload_hash, processed_at from inbox_messages
             where consumer_name = ? and message_id = ? for update`,
            [inbox.consumerName, inbox.messageId],
          );
          if (existingInbox[0]?.payload_hash !== inbox.payloadHash) {
            throw new ApplicationError(409, 'INBOX_PAYLOAD_CONFLICT', 'Message id was already used for a different payload.');
          }
          if (existingInbox[0]?.processed_at) {
            inboxAlreadyProcessed = true;
          }
        }
      }

      const replayRows = await executeInTransaction<SqlRow[]>(
        em,
        `select payload_hash, response_json, status
         from wager_transactions
         where provider_id = ? and idempotency_key = ?
         for update`,
        [input.providerId, idempotencyKey],
      );
      if (replayRows[0]) {
        if (String(replayRows[0].payload_hash).trim() !== payloadHash) {
          throw new ApplicationError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key was already used with a different business payload.');
        }
        const previous = parseResponse(replayRows[0].response_json);
        if (!previous) {
          throw new ApplicationError(503, 'TRANSACTION_RESULT_PENDING', 'The original transaction result is not yet available.', 2);
        }
        this.metrics.duplicate();
        if (inbox) {
          await this.markInboxProcessed(em, inbox);
        }
        return {
          httpStatus: statusCode(previous.status),
          body: { ...previous, idempotentReplay: true },
        };
      }
      if (inboxAlreadyProcessed) {
        throw new ApplicationError(503, 'INBOX_RESULT_UNAVAILABLE', 'Processed inbox record has no associated transaction result.', 2);
      }

      const walletRows = await executeInTransaction<SqlRow[]>(
        em,
        `select id, player_id, currency, balance::text as balance, version, created_at, updated_at
         from wallets where id = ? for update`,
        [input.walletId],
      );
      const walletRow = walletRows[0];
      if (!walletRow || walletRow.player_id !== input.playerId) {
        throw new ApplicationError(404, 'WALLET_NOT_FOUND', 'Wallet was not found for this player.');
      }

      const walletCurrency = String(walletRow.currency).trim();
      const wallet = Wallet.rehydrate({
        id: String(walletRow.id),
        playerId: String(walletRow.player_id),
        currency: walletCurrency,
        balance: { amount: formatAmount(walletRow.balance), currency: walletCurrency },
        version: Number(walletRow.version),
        createdAt: String(walletRow.created_at),
        updatedAt: String(walletRow.updated_at),
      });
      const amount = Money.from(input.money);
      const transaction = WagerTransaction.create({
        id: randomUUID(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money: amount.toJSON(),
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: eventContext.occurredAt,
      });

      await executeInTransaction(
        em,
        `insert into wager_transactions
           (id, provider_id, correlation_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount, currency,
            reference_external_transaction_id, status, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        [
          transaction.id,
          transaction.providerId,
          eventContext.correlationId,
          transaction.externalTransactionId,
          transaction.idempotencyKey,
          transaction.payloadHash,
          transaction.walletId,
          transaction.playerId,
          transaction.roundId,
          transaction.gameId,
          transaction.kind,
          transaction.money.toString(),
          transaction.money.currency,
          transaction.referenceExternalTransactionId ?? null,
          transaction.createdAt,
        ],
      );

      const reference = await this.loadReference(em, transaction);
      const existingReversalKinds = reference && transaction.requiresReference()
        ? await this.loadExistingReversalKinds(em, reference.id)
        : [];
      const outcome = WagerRules.apply({
        transaction,
        wallet,
        reference,
        existingReversalKinds,
        now: eventContext.occurredAt,
      });
      const response: SubmitWagerResult['body'] = {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      };
      const nextReferenceAttemptAt = transaction.status === WagerTransactionStatus.PendingReference
        ? new Date(occurredAt.getTime() + 1000)
        : null;

      await executeInTransaction(
        em,
        `update wager_transactions
         set status = ?, reference_transaction_id = ?, failure_code = ?,
             processed_at = ?, next_reference_attempt_at = ?, response_json = ?::jsonb
         where id = ?`,
        [
          transaction.status,
          transaction.referenceTransactionId ?? null,
          transaction.failureCode ?? null,
          transaction.processedAt ?? null,
          nextReferenceAttemptAt,
          JSON.stringify(response),
          transaction.id,
        ],
      );

      if (outcome.ledgerEntry) {
        await this.insertLedgerEntry(em, outcome.ledgerEntry);
      }
      await this.enqueueOutcome(em, transaction, wallet, outcome.ledgerEntry, eventContext);
      if (inbox) {
        await this.markInboxProcessed(em, inbox);
      }

      this.metrics.transaction(response.status);
      return { httpStatus: statusCode(response.status), body: response };
    }).catch(async (error: unknown) => {
      if (isPostgresCode(error, '23505')) {
        const constraint = getConstraint(error);
        if (constraint === 'wager_provider_idempotency_uq') {
          const existing = await this.findExisting(input.providerId, idempotencyKey);
          if (existing && existing.payloadHash !== payloadHash) {
            throw new ApplicationError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key was already used with a different business payload.');
          }
          if (existing?.response) {
            const previous = parseResponse(existing.response);
            if (previous) {
              return {
                httpStatus: statusCode(previous.status),
                body: { ...previous, idempotentReplay: true },
              };
            }
          }
          if (existing) {
            throw new ApplicationError(503, 'TRANSACTION_RESULT_PENDING', 'The original transaction result is not yet available.', 2);
          }
        }
        throw new ApplicationError(409, 'TRANSACTION_CONFLICT', 'A transaction with this provider identity already exists.');
      }
      throw error;
    });
  }

  async getById(transactionId: string): Promise<Record<string, unknown>> {
    const rows = await this.entityManager.getConnection().execute<SqlRow[]>(
      `select id, provider_id, external_transaction_id, idempotency_key, wallet_id,
              player_id, round_id, game_id, kind, amount::text as amount, currency,
              reference_external_transaction_id, reference_transaction_id, status,
              failure_code, created_at, processed_at
       from wager_transactions where id = ?`,
      [transactionId],
    );
    if (!rows[0]) {
      throw new ApplicationError(404, 'TRANSACTION_NOT_FOUND', 'Wager transaction was not found.');
    }
    return transactionResponse(rows[0]);
  }

  async getByProviderExternalId(providerId: string, externalTransactionId: string): Promise<Record<string, unknown>> {
    const rows = await this.entityManager.getConnection().execute<SqlRow[]>(
      `select id, provider_id, external_transaction_id, idempotency_key, wallet_id,
              player_id, round_id, game_id, kind, amount::text as amount, currency,
              reference_external_transaction_id, reference_transaction_id, status,
              failure_code, created_at, processed_at
       from wager_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    if (!rows[0]) {
      throw new ApplicationError(404, 'TRANSACTION_NOT_FOUND', 'Wager transaction was not found.');
    }
    return transactionResponse(rows[0]);
  }

  async processDueReferences(limit = 50): Promise<number> {
    const rows = await this.entityManager.getConnection().execute<SqlRow[]>(
      `select id from wager_transactions
       where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= now()
       order by next_reference_attempt_at, created_at
       limit ?`,
      [limit],
    );
    let retried = 0;
    for (const row of rows as SqlRow[]) {
      if (await this.retryReference(String(row.id))) {
        retried += 1;
      }
    }
    return retried;
  }

  private async loadReference(em: EntityManager, transaction: WagerTransaction): Promise<WagerTransaction | undefined> {
    if (!transaction.referenceExternalTransactionId) return undefined;
    const rows = await executeInTransaction<SqlRow[]>(
      em,
      `select * from wager_transactions
       where provider_id = ? and external_transaction_id = ?
       for update`,
      [transaction.providerId, transaction.referenceExternalTransactionId],
    );
    return rows[0] ? WagerTransaction.rehydrate(mapTransactionRow(rows[0])) : undefined;
  }

  private async retryReference(transactionId: string): Promise<boolean> {
    return this.entityManager.transactional(async (em) => {
      const transactionRows = await executeInTransaction<SqlRow[]>(
        em,
        'select * from wager_transactions where id = ? for update',
        [transactionId],
      );
      const row = transactionRows[0];
      if (
        !row
        || row.status !== WagerTransactionStatus.PendingReference
        || (row.next_reference_attempt_at && new Date(String(row.next_reference_attempt_at)) > new Date())
      ) {
        return false;
      }

      const walletRows = await executeInTransaction<SqlRow[]>(
        em,
        `select id, player_id, currency, balance::text as balance, version, created_at, updated_at
         from wallets where id = ? for update`,
        [row.wallet_id],
      );
      const walletRow = walletRows[0];
      if (!walletRow) {
        throw new ApplicationError(503, 'PENDING_WALLET_MISSING', 'Pending transaction wallet is unavailable.', 3);
      }
      const currency = String(walletRow.currency).trim();
      const wallet = Wallet.rehydrate({
        id: String(walletRow.id),
        playerId: String(walletRow.player_id),
        currency,
        balance: { amount: formatAmount(walletRow.balance), currency },
        version: Number(walletRow.version),
        createdAt: String(walletRow.created_at),
        updatedAt: String(walletRow.updated_at),
      });
      const transaction = WagerTransaction.rehydrate(mapTransactionRow(row));
      const reference = await this.loadReference(em, transaction);
      const reversalKinds = reference && transaction.requiresReference()
        ? await this.loadExistingReversalKinds(em, reference.id)
        : [];
      const occurredAt = new Date();
      const context: EventContext = {
        correlationId: String(row.correlation_id),
        causationId: transaction.id,
        occurredAt,
      };
      const result = WagerRules.apply({
        transaction,
        wallet,
        reference,
        existingReversalKinds: reversalKinds,
        now: occurredAt,
      });

      if (transaction.status === WagerTransactionStatus.PendingReference) {
        const attempts = Number(row.reference_attempts) + 1;
        if (attempts >= 20) {
          transaction.reject(reference ? FailureCode.ReferenceNotProcessed : FailureCode.MissingReference);
          await executeInTransaction(
            em,
            `update wager_transactions
             set status = ?, failure_code = ?, reference_attempts = ?,
                 next_reference_attempt_at = null
             where id = ?`,
            [transaction.status, transaction.failureCode, attempts, transaction.id],
          );
          await this.insertOutbox(em, WagerTransactionRejected.from(transaction, context));
          return true;
        }

        const backoffMs = Math.min(1000 * (2 ** (attempts - 1)), 300_000);
        await executeInTransaction(
          em,
          `update wager_transactions
           set reference_attempts = ?, next_reference_attempt_at = ?
           where id = ?`,
          [attempts, new Date(occurredAt.getTime() + backoffMs), transaction.id],
        );
        return false;
      }

      await executeInTransaction(
        em,
        `update wager_transactions
         set status = ?, reference_transaction_id = ?, failure_code = ?,
             processed_at = ?, reference_attempts = reference_attempts + 1,
             next_reference_attempt_at = null
         where id = ?`,
        [
          transaction.status,
          transaction.referenceTransactionId ?? null,
          transaction.failureCode ?? null,
          transaction.processedAt ?? null,
          transaction.id,
        ],
      );
      if (result.ledgerEntry) {
        await this.insertLedgerEntry(em, result.ledgerEntry);
      }
      await this.enqueueOutcome(em, transaction, wallet, result.ledgerEntry, context);
      return true;
    });
  }

  private async loadExistingReversalKinds(em: EntityManager, referenceId: string): Promise<WagerTransactionKind[]> {
    const rows = await executeInTransaction<SqlRow[]>(
      em,
      `select kind from wager_transactions
       where reference_transaction_id = ? and kind in ('REFUND', 'ROLLBACK')
       for update`,
      [referenceId],
    );
    return rows.map((row: SqlRow) => row.kind as WagerTransactionKind);
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

  private async enqueueOutcome(
    em: EntityManager,
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    context: EventContext,
  ): Promise<void> {
    let event: IntegrationEvent<unknown>;
    if (transaction.status === WagerTransactionStatus.Processed) {
      event = WagerTransactionProcessed.from(transaction, context);
    } else if (transaction.status === WagerTransactionStatus.Rejected) {
      event = WagerTransactionRejected.from(transaction, context);
    } else {
      event = WagerTransactionPendingReference.from(transaction, context);
    }
    await this.insertOutbox(em, event);
    if (entry) {
      await this.insertOutbox(em, WalletBalanceChanged.from(wallet, entry, transaction, context));
    }
  }

  private async insertOutbox(em: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
    await executeInTransaction(
      em,
      `insert into outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at)
       values (?, ?, ?, ?, ?::jsonb, ?)`,
      [event.eventId, event.aggregateId, event.eventType, event.version, JSON.stringify(event.toJSON()), event.occurredAt],
    );
  }

  private async markInboxProcessed(
    em: EntityManager,
    inbox: { consumerName: string; messageId: string },
  ): Promise<void> {
    await executeInTransaction(
      em,
      `update inbox_messages set processed_at = now()
       where consumer_name = ? and message_id = ?`,
      [inbox.consumerName, inbox.messageId],
    );
  }

  private async findExisting(
    providerId: string,
    idempotencyKey: string,
  ): Promise<{ payloadHash: string; response?: unknown } | undefined> {
    const rows = await this.entityManager.getConnection().execute<SqlRow[]>(
      `select payload_hash, response_json from wager_transactions where provider_id = ? and idempotency_key = ?`,
      [providerId, idempotencyKey],
    );
    return rows[0]
      ? { payloadHash: String(rows[0].payload_hash).trim(), response: rows[0].response_json }
      : undefined;
  }
}

function mapTransactionRow(row: SqlRow): WagerTransactionState {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    externalTransactionId: String(row.external_transaction_id),
    idempotencyKey: String(row.idempotency_key),
    payloadHash: String(row.payload_hash).trim(),
    walletId: String(row.wallet_id),
    playerId: String(row.player_id),
    roundId: String(row.round_id),
    gameId: String(row.game_id),
    kind: row.kind as WagerTransactionKind,
    money: { amount: formatAmount(row.amount), currency: String(row.currency).trim() },
    referenceExternalTransactionId: row.reference_external_transaction_id
      ? String(row.reference_external_transaction_id)
      : undefined,
    createdAt: String(row.created_at),
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ? String(row.reference_transaction_id) : undefined,
    failureCode: row.failure_code ? row.failure_code as FailureCode : undefined,
    processedAt: row.processed_at ? String(row.processed_at) : undefined,
  };
}

function transactionResponse(row: SqlRow): Record<string, unknown> {
  return {
    transactionId: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: { amount: formatAmount(row.amount), currency: String(row.currency).trim() },
    referenceExternalTransactionId: row.reference_external_transaction_id,
    referenceTransactionId: row.reference_transaction_id,
    status: row.status,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

function parseResponse(value: unknown): SubmitWagerResult['body'] | undefined {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return typeof parsed === 'object'
    && parsed !== null
    && 'transactionId' in parsed
    && 'status' in parsed
    && 'balance' in parsed
    ? parsed as SubmitWagerResult['body']
    : undefined;
}

function statusCode(status: WagerTransactionStatus): number {
  if (status === WagerTransactionStatus.Rejected) return 422;
  if (status === WagerTransactionStatus.Pending || status === WagerTransactionStatus.PendingReference) return 202;
  return 200;
}

function formatAmount(value: unknown): string {
  const amount = String(value);
  return amount.includes('.') ? amount.padEnd(amount.indexOf('.') + 3, '0') : `${amount}.00`;
}

function isPostgresCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function getConstraint(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'constraint' in error
    ? String(error.constraint)
    : undefined;
}
