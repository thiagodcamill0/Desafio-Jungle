import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../support/test-db";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

let n = 0;
const uuid = () => crypto.randomUUID();

async function insertWallet(balance = "0.00", playerId = uuid()) {
  const id = uuid();
  await db.sql(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values ($1, $2, 'BRL', $3, 1, now(), now())`,
    [id, playerId, balance],
  );
  return id;
}

async function insertTx(walletId: string, opts: { kind?: string; status?: string; failureCode?: string | null; ref?: string | null; refExt?: string | null } = {}) {
  const id = uuid();
  n += 1;
  await db.sql(
    `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
       created_at)
     values ($1, 'p', $2, $3, 'h', $4, $5, 'r', 'g', $6, '10.00', 'BRL', $7, $8, $9, $10, now())`,
    [id, `ext-${n}`, `key-${n}`, walletId, uuid(), opts.kind ?? "BET", opts.refExt ?? null, opts.ref ?? null, opts.status ?? "PENDING", opts.failureCode ?? null],
  );
  return id;
}

// saldo e ledger juntos na mesma transação, como o caso de uso faz
async function credit(walletId: string, txId: string, before: string, after: string, amount: string) {
  await db.tx(async (sql) => {
    await sql(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values ($1, $2, $3, 'CREDIT', $4, 'BRL', $5, $6, now())`,
      [uuid(), walletId, txId, amount, before, after],
    );
    await sql(`update wallets set balance = $1, version = version + 1 where id = $2`, [after, walletId]);
  });
}

const ledger = (walletId: string, txId: string, direction: string, amount: string, before: string, after: string) =>
  db.sql(
    `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     values ($1, $2, $3, $4, $5, 'BRL', $6, $7, now())`,
    [uuid(), walletId, txId, direction, amount, before, after],
  );

describe("wallets", () => {
  test("saldo negativo é recusado pelo CHECK", async () => {
    await expect(insertWallet("-1.00")).rejects.toThrow(/wallets_balance_check/);
  });

  test("segunda wallet do mesmo player+moeda viola UNIQUE", async () => {
    const player = uuid();
    await insertWallet("0.00", player);
    await expect(insertWallet("0.00", player)).rejects.toThrow(/ux_wallets_player_currency/);
  });

  test("alterar saldo sem incrementar version é recusado", async () => {
    const w = await insertWallet();
    await expect(db.sql(`update wallets set balance = 0.00, version = 2 where id = $1`, [w])).rejects.toThrow(/version/);
  });

  test("saldo sem lançamento correspondente no ledger é recusado no commit", async () => {
    const w = await insertWallet();
    await expect(db.sql(`update wallets set balance = 50.00, version = 2 where id = $1`, [w])).rejects.toThrow(/does not match ledger/);
  });

  test("saldo inicial > 0 sem lançamento de abertura é recusado no commit", async () => {
    await expect(insertWallet("100.00")).rejects.toThrow(/does not match ledger/);
  });

  test("saldo e ledger alterados juntos são aceitos", async () => {
    const w = await insertWallet();
    const t = await insertTx(w, { kind: "WIN" });
    await credit(w, t, "0.00", "25.00", "25.00");
    const [row] = await db.sql(`select balance, version from wallets where id = $1`, [w]);
    expect(row).toEqual({ balance: "25.00", version: 2 });
  });
});

describe("wallet_ledger_entries", () => {
  let w: string;
  let t: string;
  beforeEach(async () => {
    w = await insertWallet();
    t = await insertTx(w, { kind: "WIN" });
    await credit(w, t, "0.00", "10.00", "10.00");
  });

  test("UPDATE em wallet_ledger_entries lança erro", async () => {
    await expect(db.sql(`update wallet_ledger_entries set amount = 1 where wallet_id = $1`, [w])).rejects.toThrow(/append-only/);
  });

  test("DELETE lança erro", async () => {
    await expect(db.sql(`delete from wallet_ledger_entries where wallet_id = $1`, [w])).rejects.toThrow(/append-only/);
  });

  test("TRUNCATE lança erro", async () => {
    await expect(db.sql(`truncate wallet_ledger_entries cascade`)).rejects.toThrow(/append-only/);
  });

  test("lançamento com aritmética errada viola CHECK", async () => {
    const t2 = await insertTx(w, { kind: "WIN" });
    await expect(ledger(w, t2, "CREDIT", "5.00", "10.00", "16.00")).rejects.toThrow(/ck_ledger_balanced/);
  });

  test("lançamento sem alterar o saldo da wallet é recusado no commit", async () => {
    const t2 = await insertTx(w, { kind: "WIN" });
    await expect(ledger(w, t2, "CREDIT", "5.00", "10.00", "15.00")).rejects.toThrow(/does not match ledger/);
  });

  test("dois lançamentos da mesma transação na mesma wallet violam UNIQUE", async () => {
    await expect(ledger(w, t, "CREDIT", "5.00", "10.00", "15.00")).rejects.toThrow(/ux_ledger_wallet_transaction/);
  });
});

describe("wager_transactions", () => {
  test("REFUND sem referência viola CHECK", async () => {
    const w = await insertWallet();
    await expect(insertTx(w, { kind: "REFUND" })).rejects.toThrow(/ck_reversal_requires_reference/);
  });

  test("REJECTED sem failure_code viola CHECK", async () => {
    const w = await insertWallet();
    await expect(insertTx(w, { status: "REJECTED" })).rejects.toThrow(/ck_decided_failure_code/);
  });

  test("kind fora do domínio viola CHECK", async () => {
    const w = await insertWallet();
    await expect(insertTx(w, { kind: "JACKPOT" })).rejects.toThrow(/wager_transactions_kind_check/);
  });

  test("segunda reversão PROCESSED da mesma referência viola ux_single_reversal (REFUND + ROLLBACK)", async () => {
    const w = await insertWallet();
    const bet = await insertTx(w, { status: "PROCESSED" });
    await insertTx(w, { kind: "REFUND", status: "PROCESSED", ref: bet, refExt: "bet" });
    await expect(insertTx(w, { kind: "ROLLBACK", status: "PROCESSED", ref: bet, refExt: "bet" })).rejects.toThrow(/ux_single_reversal/);
  });

  test("UPDATE de transação PROCESSED é recusado pelo trigger", async () => {
    const w = await insertWallet();
    const t = await insertTx(w, { status: "PROCESSED" });
    await expect(db.sql(`update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = $1`, [t])).rejects.toThrow(/terminal/);
  });

  test("transação PENDING pode ser decidida", async () => {
    const w = await insertWallet();
    const t = await insertTx(w);
    await db.sql(`update wager_transactions set status = 'PROCESSED', processed_at = now() where id = $1`, [t]);
    const [row] = await db.sql(`select status from wager_transactions where id = $1`, [t]);
    expect(row?.status).toBe("PROCESSED");
  });

  test("DELETE de transação é recusado", async () => {
    const w = await insertWallet();
    const t = await insertTx(w, { status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    await expect(db.sql(`delete from wager_transactions where id = $1`, [t])).rejects.toThrow(/cannot be deleted/);
  });
});

describe("inbox / outbox", () => {
  test("mesma (consumer_name, message_id) viola PRIMARY KEY", async () => {
    const insert = () => db.sql(`insert into inbox_messages values ('c', 'm-1', 'h', now(), null)`);
    await insert();
    await expect(insert()).rejects.toThrow(/inbox_messages_pkey/);
  });

  test("outbox gera seq crescente", async () => {
    const insert = () =>
      db.sql(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         values ($1, $2, 'E', '{}'::jsonb, now(), now()) returning seq`,
        [uuid(), uuid()],
      );
    const [a] = await insert();
    const [b] = await insert();
    expect(BigInt(b?.seq) > BigInt(a?.seq)).toBe(true);
  });
});

describe("migration", () => {
  test("migrator.down() seguido de up() funciona (reversibilidade)", async () => {
    await db.migrateDown();
    expect(await db.sql(`select to_regclass('public.wallets') as t`)).toEqual([{ t: null }]);
    await db.migrateUp();
    expect(await db.sql(`select to_regclass('public.wallets')::text as t`)).toEqual([{ t: "wallets" }]);
  });
});
