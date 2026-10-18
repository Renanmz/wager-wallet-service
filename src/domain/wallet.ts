import { DomainValidationError } from './errors.ts';
import { Money, MoneyProps } from './money.ts';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    if (!props.id || !props.playerId) {
      throw new DomainValidationError('Wallet id and playerId are required.');
    }

    const now = new Date();
    const balance = Money.from(props.initialBalance.toJSON());

    if (balance.isNegative()) {
      throw new DomainValidationError('Wallet initial balance cannot be negative.');
    }

    return new Wallet(props.id, props.playerId, balance.currency, balance, 1, now, now);
  }

  static rehydrate(state: WalletState): Wallet {
    const balance = Money.from(state.balance);
    return new Wallet(
      state.id,
      state.playerId,
      balance.currency,
      balance,
      Number(state.version) || 0,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  credit(amount: Money): Wallet {
    this.assertSameCurrency(amount);
    if (amount.isZero()) {
      return this;
    }
    if (!amount.isPositive()) {
      throw new DomainValidationError('Wallet credit amount must be positive.');
    }

    this._balance = this._balance.add(amount);
    this._version += 1;
    this._updatedAt = new Date();
    return this;
  }

  debit(amount: Money): Wallet {
    this.assertSameCurrency(amount);
    if (amount.isZero()) {
      return this;
    }
    if (!amount.isPositive()) {
      throw new DomainValidationError('Wallet debit amount must be positive.');
    }

    const nextBalance = this._balance.subtract(amount);
    if (nextBalance.isNegative()) {
      throw new DomainValidationError('Wallet balance cannot become negative.');
    }

    this._balance = nextBalance;
    this._version += 1;
    this._updatedAt = new Date();
    return this;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new DomainValidationError(`Wallet currency ${this.currency} does not match movement currency ${money.currency}.`);
    }
  }
}
