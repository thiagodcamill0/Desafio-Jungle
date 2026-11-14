import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { TransactionRunner } from "../../src/application/ports";
import { SubmitWagerTransaction } from "../../src/application/submit-wager-transaction";
import { MikroOrmTransactionRunner } from "../../src/infrastructure/persistence/transaction-runner";
import { SystemClock, UuidV7Generator } from "../../src/infrastructure/system";
import { createTestApp, postJson, type TestApp } from "../support/test-app";
import { assertLedgerMatchesBalance } from "../support/invariants";
import { countLedger, getWallet, openWallet, postWager, wager } from "../support/factories";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe("POST /wagering/transactions", () => {
  test("BET 25.00 em wallet de 1000.00 → 200 PROCESSED saldo 975.00 idempotentReplay false", async () => {
    const w = await openWallet(t.baseUrl, "1000.00");
    const res = await postWager(t.baseUrl, wager({ ...w, amount: "25.00" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transactionId: expect.any(String), status: "PROCESSED", balance: { amount: "975.00", currency: "BRL" }, idempotentReplay: false });
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("mesma requisição de novo → 200, mesmo transactionId, saldo 975.00, idempotentReplay true", async () => {
    const w = await openWallet(t.baseUrl, "1000.00");
    const cmd = wager({ ...w, amount: "25.00" });
    const first = await postWager(t.baseUrl, cmd);
    const again = await postWager(t.baseUrl, cmd);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("mesma key com amount 30.00 → 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", async () => {
    const w = await openWallet(t.baseUrl, "1000.00");
    const cmd = wager({ ...w, amount: "25.00" });
    await postWager(t.baseUrl, cmd);
    const res = await postWager(t.baseUrl, { ...cmd, money: { amount: "30.00", currency: "BRL" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("975.00");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("key nova com mesmo providerId+externalTransactionId → 409 EXTERNAL_TRANSACTION_ID_REUSED", async () => {
    const w = await openWallet(t.baseUrl, "1000.00");
    const cmd = wager({ ...w, amount: "25.00" });
    await postWager(t.baseUrl, cmd);
    const res = await postWager(t.baseUrl, { ...cmd, idempotencyKey: "another-key" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EXTERNAL_TRANSACTION_ID_REUSED");
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("replay devolve o saldo do momento original", async () => {
    const w = await openWallet(t.baseUrl, "1000.00");
    const a = wager({ ...w, amount: "25.00" });
    await postWager(t.baseUrl, a);
    await postWager(t.baseUrl, wager({ ...w, amount: "25.00" }));
    const replay = await postWager(t.baseUrl, a);
    expect(replay.body.balance.amount).toBe("975.00");
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("950.00");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("BET sem saldo → 422 INSUFFICIENT_FUNDS, persistida e auditável", async () => {
    const w = await openWallet(t.baseUrl, "10.00");
    const res = await postWager(t.baseUrl, wager({ ...w, amount: "25.00" }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "INSUFFICIENT_FUNDS", status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "10.00" } });
    const [row] = await t.sql(`select status, failure_code from wager_transactions where id = $1`, [res.body.transactionId]);
    expect(row).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    const events = await t.sql(`select event_type from outbox_messages where payload->'data'->>'transactionId' = $1`, [res.body.transactionId]);
    expect(events).toEqual([{ event_type: "WagerTransactionRejected" }]);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("WIN credita e LOSS não move saldo, ambos com evento Processed", async () => {
    const w = await openWallet(t.baseUrl, "10.00");
    const win = await postWager(t.baseUrl, wager({ ...w, kind: "WIN", amount: "5.00" }));
    expect(win.body).toMatchObject({ status: "PROCESSED", balance: { amount: "15.00" } });
    const loss = await postWager(t.baseUrl, wager({ ...w, kind: "LOSS", amount: "0.00" }));
    expect(loss.body).toMatchObject({ status: "PROCESSED", balance: { amount: "15.00" } });
    expect((await getWallet(t.baseUrl, w.walletId)).version).toBe(2);

    const types = await t.sql(`select event_type from outbox_messages where payload->'data'->>'transactionId' = $1 order by seq`, [loss.body.transactionId]);
    expect(types).toEqual([{ event_type: "WagerTransactionProcessed" }]);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test('Idempotency-Key "   " → 400 MISSING_IDEMPOTENCY_KEY', async () => {
    const w = await openWallet(t.baseUrl, "10.00");
    const res = await postWager(t.baseUrl, { ...wager(w), idempotencyKey: "   " });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  test("sem header Idempotency-Key → 400 MISSING_IDEMPOTENCY_KEY", async () => {
    const { idempotencyKey: _, ...body } = wager();
    const res = await postJson(`${t.baseUrl}/wagering/transactions`, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  test('BET "0.00" → 400 INVALID_MONEY; "123456789012345678.00" → 400 INVALID_MONEY', async () => {
    const w = await openWallet(t.baseUrl, "10.00");
    for (const amount of ["0.00", "123456789012345678.00"]) {
      const res = await postWager(t.baseUrl, wager({ ...w, amount }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_MONEY");
    }
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("playerId diferente do dono → 422 WALLET_PLAYER_MISMATCH; replay → 422 idempotentReplay true", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ walletId: w.walletId, amount: "10.00" });
    const res = await postWager(t.baseUrl, cmd);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "WALLET_PLAYER_MISMATCH", status: "REJECTED", idempotentReplay: false });
    const replay = await postWager(t.baseUrl, cmd);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ code: "WALLET_PLAYER_MISMATCH", transactionId: res.body.transactionId, idempotentReplay: true });
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("100.00");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("walletId inexistente → 422 WALLET_NOT_FOUND, sem persistir", async () => {
    const cmd = wager();
    const res = await postWager(t.baseUrl, cmd);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("WALLET_NOT_FOUND");
    expect(await t.sql(`select 1 from wager_transactions where idempotency_key = $1`, [cmd.idempotencyKey])).toEqual([]);
  });

  test("kind OPENING → 400 KIND_NOT_ALLOWED", async () => {
    const w = await openWallet(t.baseUrl, "10.00");
    const res = await postWager(t.baseUrl, wager({ ...w, kind: "OPENING" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("KIND_NOT_ALLOWED");
  });

  test("kind desconhecido → 400 INVALID_PAYLOAD", async () => {
    const res = await postWager(t.baseUrl, wager({ kind: "JACKPOT" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });

  test("atomicidade: erro depois de gravar tudo → nada persiste e saldo intacto", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const real = new MikroOrmTransactionRunner(t.app.get(MikroORM));
    const failing: TransactionRunner = {
      run: (work) =>
        real.run(async (repos) => {
          await work(repos);
          throw new Error("crash before commit");
        }),
    };
    const useCase = new SubmitWagerTransaction(failing, new SystemClock(), new UuidV7Generator());
    const counts = async () =>
      (
        await t.sql(
          `select (select count(*) from wager_transactions)::int as tx, (select count(*) from wallet_ledger_entries)::int as ledger,
                  (select count(*) from outbox_messages)::int as outbox`,
        )
      )[0];
    const before = await counts();

    await expect(useCase.execute(wager({ ...w, amount: "30.00" }), { correlationId: "c" })).rejects.toThrow("crash before commit");
    expect(await counts()).toEqual(before);
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("100.00");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });
});

describe("entradas que não podem virar 500/503", () => {
  test("byte NUL em campo de texto → 400 INVALID_PAYLOAD (não 503)", async () => {
    const w = await openWallet(t.baseUrl, "10.00");
    const res = await postWager(t.baseUrl, wager({ ...w, roundId: "round\u0000x" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });

  test("Idempotency-Key ou externalTransactionId gigante → 400 INVALID_PAYLOAD (não 500)", async () => {
    const w = await openWallet(t.baseUrl, "10.00");
    const longKey = await postWager(t.baseUrl, { ...wager(w), idempotencyKey: "k".repeat(3_000) });
    expect(longKey.status).toBe(400);
    expect(longKey.body.code).toBe("INVALID_PAYLOAD");
    const longExt = await postWager(t.baseUrl, wager({ ...w, externalTransactionId: "e".repeat(3_000) }));
    expect(longExt.status).toBe(400);
    expect(longExt.body.code).toBe("INVALID_PAYLOAD");
  });

  test("parâmetros da rota de provider com NUL ou gigantes → 400", async () => {
    for (const path of ["a%00b/wagering/transactions/x", `p/wagering/transactions/${"x".repeat(3_000)}`]) {
      const res = await fetch(`${t.baseUrl}/providers/${path}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_PAYLOAD");
    }
  });
});
