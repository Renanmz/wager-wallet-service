import { DomainValidationError } from './errors.ts';
import { Money } from './money.ts';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date | string;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: {
    amount: string;
    currency: string;
  };
  balanceBefore: {
    amount: string;
    currency: string;
  };
  balanceAfter: {
    amount: string;
    currency: string;
  };
  createdAt: Date | string;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new DomainValidationError('Ledger entry identity is required.');
    }

    if (props.money.currency !== props.balanceBefore.currency || props.money.currency !== props.balanceAfter.currency) {
      throw new DomainValidationError('Ledger entry must use a single wallet currency.');
    }

    if (props.direction === LedgerDirection.Credit) {
      const expected = props.balanceBefore.add(props.money);
      if (!expected.equals(props.balanceAfter)) {
        throw new DomainValidationError('Credit ledger entry does not balance.');
      }
    } else if (props.direction === LedgerDirection.Debit) {
      const expected = props.balanceBefore.subtract(props.money);
      if (!expected.equals(props.balanceAfter)) {
        throw new DomainValidationError('Debit ledger entry does not balance.');
      }
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt ?? Date.now()),
    );
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      new Date(state.createdAt),
    );
  }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
