import Decimal from 'decimal.js';
import { DomainValidationError } from './errors.ts';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new DomainValidationError('Money input is required.');
    }

    const amount = props.amount.trim();
    const currency = props.currency.trim().toUpperCase();

    if (!amount || !currency) {
      throw new DomainValidationError('Money amount and currency are required.');
    }

    if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) {
      throw new DomainValidationError('Money amount must be a non-negative decimal string with at most two fractional digits.');
    }

    const parsed = new Decimal(amount);
    if (!parsed.isFinite()) {
      throw new DomainValidationError('Money amount must be finite.');
    }

    if (parsed.decimalPlaces() > 2) {
      throw new DomainValidationError('Money amount must have at most two decimal places.');
    }

    return new Money(parsed, currency);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), normalizeCurrency(currency));
  }

  static fromDecimal(value: Decimal, currency: string): Money {
    return new Money(value, normalizeCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.toJSON().amount;
  }

  get raw(): Decimal {
    return this.value;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainValidationError(`Currency mismatch: ${this.currency} vs ${other.currency}.`);
    }
  }
}

function normalizeCurrency(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new DomainValidationError('Currency must be a three-letter ISO-4217 code.');
  }
  return normalized;
}
