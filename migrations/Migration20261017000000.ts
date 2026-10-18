import { Migration } from '@mikro-orm/migrations';

export class Migration20261017000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(20, 2) not null default 0,
        version integer not null default 1,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_balance_nonnegative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$')
      );

      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        correlation_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets(id) on delete restrict,
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id text null,
        reference_transaction_id uuid null,
        status text not null,
        failure_code text null,
        created_at timestamptz not null default now(),
        processed_at timestamptz null,
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz null,
        response_json jsonb null,
        constraint wager_provider_idempotency_uq unique (provider_id, idempotency_key),
        constraint wager_provider_external_id_uq unique (provider_id, external_transaction_id),
        constraint wager_id_provider_player_wallet_round_currency_uq
          unique (id, provider_id, player_id, wallet_id, round_id, currency),
        constraint wager_id_wallet_uq unique (id, wallet_id),
        constraint wager_reference_same_context_fk
          foreign key (reference_transaction_id, provider_id, player_id, wallet_id, round_id, currency)
          references wager_transactions (id, provider_id, player_id, wallet_id, round_id, currency)
          deferrable initially immediate,
        constraint wager_kind_valid check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_status_valid check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_amount_positive check (amount > 0),
        constraint wager_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_reference_required check (
          (kind in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is not null)
          or kind not in ('REFUND', 'ROLLBACK')
          or kind = 'OPENING'
        ),
        constraint wager_reference_state check (
          (reference_transaction_id is null)
          or (reference_external_transaction_id is not null)
        ),
        constraint wager_attempts_nonnegative check (reference_attempts >= 0)
      );

      create unique index wager_reference_reversal_uq
        on wager_transactions (provider_id, reference_transaction_id, kind)
        where reference_transaction_id is not null and kind in ('REFUND', 'ROLLBACK');

      create index wager_pending_reference_due_idx
        on wager_transactions (next_reference_attempt_at, created_at)
        where status = 'PENDING_REFERENCE';

      create index wager_wallet_created_idx
        on wager_transactions (wallet_id, created_at desc);

      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets(id) on delete restrict,
        transaction_id uuid not null references wager_transactions(id) on delete restrict,
        direction text not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        created_at timestamptz not null default now(),
        constraint ledger_wallet_transaction_uq unique (wallet_id, transaction_id),
        constraint ledger_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balances_nonnegative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint ledger_transaction_wallet_fk
          foreign key (transaction_id, wallet_id)
          references wager_transactions (id, wallet_id),
        constraint ledger_arithmetic_valid check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );

      create index ledger_wallet_cursor_idx on wallet_ledger_entries (wallet_id, created_at desc, id desc);
      create unique index ledger_transaction_uq on wallet_ledger_entries (transaction_id);

      create function apply_wallet_ledger_entry() returns trigger language plpgsql as $$
      declare
        current_balance numeric(20, 2);
        current_currency char(3);
        transaction_kind text;
        transaction_amount numeric(20, 2);
        transaction_currency char(3);
        transaction_wallet_id uuid;
      begin
        select balance, currency into current_balance, current_currency
          from wallets where id = new.wallet_id for update;

        if not found then
          raise exception 'wallet_not_found' using errcode = '23503';
        end if;

        if current_currency <> new.currency then
          raise exception 'ledger_currency_mismatch' using errcode = '23514';
        end if;

        select kind, amount, currency, wallet_id
          into transaction_kind, transaction_amount, transaction_currency, transaction_wallet_id
          from wager_transactions where id = new.transaction_id;

        if transaction_wallet_id <> new.wallet_id
          or transaction_amount <> new.amount
          or transaction_currency <> new.currency then
          raise exception 'ledger_transaction_mismatch' using errcode = '23514';
        end if;

        if transaction_kind = 'OPENING' then
          if new.direction <> 'CREDIT' or new.balance_before <> 0
            or current_balance <> new.balance_after
            or exists (select 1 from wallet_ledger_entries where wallet_id = new.wallet_id) then
            raise exception 'invalid_opening_ledger_entry' using errcode = '23514';
          end if;
          return new;
        end if;

        if current_balance <> new.balance_before then
          raise exception 'wallet_balance_changed' using errcode = '40001';
        end if;

        perform set_config('wager.ledger_update', 'on', true);
        update wallets
          set balance = new.balance_after,
              version = version + 1,
              updated_at = new.created_at
          where id = new.wallet_id;
        perform set_config('wager.ledger_update', 'off', true);

        return new;
      end;
      $$;

      create function prevent_direct_wallet_balance_change() returns trigger language plpgsql as $$
      begin
        if (new.balance is distinct from old.balance or new.version is distinct from old.version)
          and current_setting('wager.ledger_update', true) is distinct from 'on' then
          raise exception 'wallet balance and version can only be changed by the ledger' using errcode = '55000';
        end if;
        return new;
      end;
      $$;

      create trigger wallet_balance_ledger_owned
        before update of balance, version on wallets
        for each row execute function prevent_direct_wallet_balance_change();

      create function require_opening_ledger_for_funded_wallet() returns trigger language plpgsql as $$
      begin
        if new.balance > 0 and not exists (
          select 1
          from wallet_ledger_entries l
          join wager_transactions t on t.id = l.transaction_id
          where l.wallet_id = new.id
            and l.direction = 'CREDIT'
            and l.balance_before = 0
            and l.balance_after = new.balance
            and t.kind = 'OPENING'
        ) then
          raise exception 'funded_wallet_requires_opening_ledger' using errcode = '23514';
        end if;
        return null;
      end;
      $$;

      create constraint trigger wallet_opening_ledger_required
        after insert on wallets
        deferrable initially deferred
        for each row execute function require_opening_ledger_for_funded_wallet();

      create trigger wallet_ledger_apply_balance
        before insert on wallet_ledger_entries
        for each row execute function apply_wallet_ledger_entry();

      create function prevent_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet ledger entries are immutable' using errcode = '55000';
      end;
      $$;

      create trigger wallet_ledger_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function prevent_ledger_mutation();

      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null default now(),
        processed_at timestamptz null,
        primary key (consumer_name, message_id)
      );

      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        event_version integer not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz null,
        locked_by text null,
        locked_until timestamptz null,
        published_at timestamptz null,
        created_at timestamptz not null default now(),
        constraint outbox_attempts_nonnegative check (attempts >= 0),
        constraint outbox_version_positive check (event_version >= 1)
      );

      create index outbox_due_idx
        on outbox_messages (coalesce(next_attempt_at, created_at), created_at, id)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table if exists outbox_messages;
      drop table if exists inbox_messages;
      drop trigger if exists wallet_ledger_immutable on wallet_ledger_entries;
      drop trigger if exists wallet_ledger_apply_balance on wallet_ledger_entries;
      drop trigger if exists wallet_balance_ledger_owned on wallets;
      drop trigger if exists wallet_opening_ledger_required on wallets;
      drop function if exists require_opening_ledger_for_funded_wallet();
      drop function if exists prevent_direct_wallet_balance_change();
      drop function if exists prevent_ledger_mutation();
      drop function if exists apply_wallet_ledger_entry();
      drop table if exists wallet_ledger_entries;
      drop table if exists wager_transactions;
      drop table if exists wallets;
    `);
  }
}
