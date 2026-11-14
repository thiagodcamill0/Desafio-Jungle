import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, getJson, postJson, type TestApp } from "../support/test-app";
import { assertLedgerMatchesBalance } from "../support/invariants";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

const openWallet = (amount: string, playerId: string = crypto.randomUUID(), currency = "BRL") =>
  postJson(`${t.baseUrl}/wallets`, { playerId, initialBalance: { amount, currency } });

describe("POST /wallets", () => {
  test("1000.00 → 201 com version 1 e saldo 1000.00", async () => {
    const playerId = crypto.randomUUID();
    const res = await openWallet("1000.00", playerId);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    await assertLedgerMatchesBalance(t.sql, res.body.id);
  });

  test("ledger tem 1 CREDIT de 1000.00 e outbox tem 1 WalletBalanceChanged", async () => {
    const { body } = await openWallet("1000.00");
    const entries = await t.sql(`select direction, amount::text from wallet_ledger_entries where wallet_id = $1`, [body.id]);
    expect(entries).toEqual([{ direction: "CREDIT", amount: "1000.00" }]);

    const [opening] = await t.sql(`select kind, status, observed_balance::text as observed from wager_transactions where wallet_id = $1`, [body.id]);
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED", observed: "1000.00" });

    const events = await t.sql(`select event_type, payload from outbox_messages where aggregate_id = $1`, [body.id]);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("WalletBalanceChanged");
    expect(events[0].payload.data.balanceAfter).toEqual({ amount: "1000.00", currency: "BRL" });
    await assertLedgerMatchesBalance(t.sql, body.id);
  });

  test("saldo 0.00 → nenhum lançamento", async () => {
    const res = await openWallet("0.00");
    expect(res.status).toBe(201);
    expect(await t.sql(`select 1 from wallet_ledger_entries where wallet_id = $1`, [res.body.id])).toEqual([]);
    expect(await t.sql(`select 1 from outbox_messages where aggregate_id = $1`, [res.body.id])).toEqual([]);
    await assertLedgerMatchesBalance(t.sql, res.body.id);
  });

  test("duplicada → 409 WALLET_ALREADY_EXISTS", async () => {
    const playerId = crypto.randomUUID();
    await openWallet("10.00", playerId);
    const res = await openWallet("5.00", playerId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WALLET_ALREADY_EXISTS");
    expect(await t.sql(`select 1 from wallets where player_id = $1`, [playerId])).toHaveLength(1);
  });

  test("mesmo player com outra moeda é permitido", async () => {
    const playerId = crypto.randomUUID();
    await openWallet("10.00", playerId);
    expect((await openWallet("10.00", playerId, "USD")).status).toBe(201);
  });

  test('amount "10.5" → 400 INVALID_MONEY', async () => {
    const res = await openWallet("10.5");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: "INVALID_MONEY", message: expect.any(String) });
  });

  test("amount numérico → 400 INVALID_MONEY", async () => {
    const res = await postJson(`${t.baseUrl}/wallets`, { playerId: crypto.randomUUID(), initialBalance: { amount: 10, currency: "BRL" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_MONEY");
  });

  test("playerId não-UUID → 400 INVALID_PAYLOAD", async () => {
    const res = await postJson(`${t.baseUrl}/wallets`, { playerId: "player-1", initialBalance: { amount: "1.00", currency: "BRL" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });

  test("JSON malformado → 400 INVALID_PAYLOAD", async () => {
    const res = await fetch(`${t.baseUrl}/wallets`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_PAYLOAD");
  });
});

describe("GET /wallets/:walletId", () => {
  test("devolve a wallet criada", async () => {
    const created = await openWallet("42.00");
    const res = await getJson(`${t.baseUrl}/wallets/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  test("inexistente → 404 WALLET_NOT_FOUND", async () => {
    const res = await getJson(`${t.baseUrl}/wallets/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("WALLET_NOT_FOUND");
  });

  test("id não-UUID → 400 INVALID_PAYLOAD", async () => {
    const res = await getJson(`${t.baseUrl}/wallets/abc`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });
});
