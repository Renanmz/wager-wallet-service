import { DomainValidationError, InvalidTransactionStateError } from './errors.ts';
import { Money, MoneyProps } from './money.ts';
import { LedgerDirection as WalletLedgerDirection } from './wallet-ledger-entry.ts';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  MissingReference = 'MISSING_REFERENCE',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  InvalidReference = 'INVALID_REFERENCE',
  InvalidPayload = 'INVALID_PAYLOAD',
  RuleViolation = 'RULE_VIOLATION',
  IncompatibleCurrency = 'INCOMPATIBLE_CURRENCY',
  DuplicateReplay = 'DUPLICATE_REPLAY',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt?: Date | string;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date | string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date | string;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.id || !props.providerId || !props.externalTransactionId || !props.idempotencyKey || !props.payloadHash) {
      throw new DomainValidationError('Wager transaction identity fields are required.');
    }

    const money = Money.from(props.money);
    if (!money.isPositive()) {
      throw new DomainValidationError('Wager transaction amount must be greater than zero.');
    }
    const kind = props.kind;
    if (kind === WagerTransactionKind.Opening) {
      throw new DomainValidationError('OPENING transactions must be created through the internal wallet-opening flow.');
    }
    const requiresReference = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
    if (requiresReference && !props.referenceExternalTransactionId?.trim()) {
      throw new DomainValidationError(`${kind} transactions require a reference external transaction id.`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      kind,
      money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt ?? Date.now()),
      WagerTransactionStatus.Pending,
    );
  }

  static createOpening(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind !== WagerTransactionKind.Opening) {
      throw new DomainValidationError('Internal wallet-opening transaction must have kind OPENING.');
    }
    if (!props.id || !props.providerId || !props.externalTransactionId || !props.idempotencyKey || !props.payloadHash) {
      throw new DomainValidationError('Wager transaction identity fields are required.');
    }
    const money = Money.from(props.money);
    if (!money.isPositive()) {
      throw new DomainValidationError('Wallet opening amount must be greater than zero.');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      money,
      undefined,
      new Date(props.createdAt ?? Date.now()),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date = new Date()): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot process terminal transaction ${this.id}.`);
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot move terminal transaction ${this.id} back to pending reference.`);
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot reject terminal transaction ${this.id}.`);
    }

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot fail terminal transaction ${this.id}.`);
    }

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.Processed
      || this._status === WagerTransactionStatus.Rejected
      || this._status === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): WalletLedgerDirection | undefined {
    if (this.kind === WagerTransactionKind.Bet) {
      return WalletLedgerDirection.Debit;
    }

    if (this.kind === WagerTransactionKind.Win || this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Opening) {
      return WalletLedgerDirection.Credit;
    }

    if (this.kind === WagerTransactionKind.Loss) {
      return undefined;
    }

    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference) {
        return undefined;
      }

      const direction = reference.ledgerDirectionFor();
      if (!direction) {
        return undefined;
      }

      return direction === WalletLedgerDirection.Credit ? WalletLedgerDirection.Debit : WalletLedgerDirection.Credit;
    }

    return undefined;
  }
}
