import { Migration } from "@mikro-orm/migrations";

// Schema inicial. As regras de dinheiro ficam no banco também, não só no código.
export class Migration20261113000000 extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(19,2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint ux_wallets_player_currency unique (player_id, currency)
      );`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(19,2) not null check (amount >= 0),
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        observed_balance numeric(19,2) check (observed_balance >= 0),
        reference_attempts integer not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint ux_wager_idempotency_key unique (idempotency_key),
        constraint ux_wager_provider_external unique (provider_id, external_transaction_id),
        constraint ck_reversal_requires_reference
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_decided_failure_code
          check (status not in ('REJECTED', 'FAILED') or failure_code is not null)
      );`);
    // uma reversão por referência, seja REFUND ou ROLLBACK
    this.addSql(`
      create unique index ux_single_reversal on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';`);
    this.addSql(`
      create index ix_pending_reference on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';`);
    this.addSql(`create index ix_wager_wallet on wager_transactions (wallet_id);`);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        seq bigint generated always as identity,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(19,2) not null check (amount > 0),
        currency char(3) not null,
        balance_before numeric(19,2) not null check (balance_before >= 0),
        balance_after numeric(19,2) not null check (balance_after >= 0),
        created_at timestamptz not null,
        constraint ux_ledger_seq unique (seq),
        constraint ux_ledger_wallet_transaction unique (wallet_id, transaction_id),
        constraint ck_ledger_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT' and balance_after = balance_before - amount))
      );`);
    this.addSql(`create index ix_ledger_wallet_seq on wallet_ledger_entries (wallet_id, seq);`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        seq bigint generated always as identity,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz not null,
        published_at timestamptz
      );`);
    this.addSql(`create index ix_outbox_due on outbox_messages (next_attempt_at) where published_at is null;`);

    // ledger só aceita insert
    this.addSql(`
      create function ledger_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% blocked)', tg_op using errcode = 'restrict_violation';
      end $$;`);
    this.addSql(`
      create trigger trg_ledger_append_only before update or delete on wallet_ledger_entries
        for each row execute function ledger_append_only();`);
    this.addSql(`
      create trigger trg_ledger_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function ledger_append_only();`);

    // transação finalizada não muda e nenhuma é apagada
    this.addSql(`
      create function wager_transaction_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions cannot be deleted (id %)', old.id using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%) and cannot change', old.id, old.status using errcode = 'restrict_violation';
        end if;
        return new;
      end $$;`);
    this.addSql(`
      create trigger trg_terminal_immutable before update or delete on wager_transactions
        for each row execute function wager_transaction_guard();`);

    // version sobe junto com o saldo
    this.addSql(`
      create function wallet_version_guard() returns trigger language plpgsql as $$
      begin
        if new.balance is distinct from old.balance and new.version <> old.version + 1 then
          raise exception 'wallet %: version must increment by 1 when balance changes', old.id using errcode = 'check_violation';
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet %: version must not change when balance does not change', old.id using errcode = 'check_violation';
        end if;
        return new;
      end $$;`);
    this.addSql(`
      create trigger trg_wallet_version before update on wallets
        for each row execute function wallet_version_guard();`);

    // saldo tem que bater com o último lançamento; checado no commit
    this.addSql(`
      create function wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        target uuid := (to_jsonb(new) ->> tg_argv[0])::uuid; -- 'id' em wallets, 'wallet_id' no ledger
        stored numeric(19,2);
        last_after numeric(19,2);
      begin
        select balance into stored from wallets where id = target;
        select balance_after into last_after from wallet_ledger_entries where wallet_id = target order by seq desc limit 1;
        if stored is distinct from coalesce(last_after, 0.00) then
          raise exception 'wallet % balance % does not match ledger %', target, stored, coalesce(last_after, 0.00)
            using errcode = 'check_violation';
        end if;
        return null;
      end $$;`);
    this.addSql(`
      create constraint trigger trg_wallet_matches_ledger after insert or update of balance on wallets
        deferrable initially deferred for each row execute function wallet_matches_ledger('id');`);
    this.addSql(`
      create constraint trigger trg_ledger_matches_wallet after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function wallet_matches_ledger('wallet_id');`);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists wallet_matches_ledger();`);
    this.addSql(`drop function if exists wallet_version_guard();`);
    this.addSql(`drop function if exists wager_transaction_guard();`);
    this.addSql(`drop function if exists ledger_append_only();`);
  }
}
