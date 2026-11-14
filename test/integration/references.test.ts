import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { SubmitWagerTransaction } from "../../src/application/submit-wager-transaction";
import { MikroOrmTransactionRunner } from "../../src/infrastructure/persistence/transaction-runner";
import { UuidV7Generator } from "../../src/infrastructure/system";
import { PendingReferenceWorker } from "../../src/infrastructure/workers/pending-reference-worker";
import { createTestApp, type TestApp } from "../support/test-app";
import { assertLedgerMatchesBalance } from "../support/invariants";
import { countLedger, getWallet, openWallet, postWager, wager } from "../support/factories";

let t: TestApp;
let worker: PendingReferenceWorker;
// relógio fake só para o worker: avança sem esperar tempo real
let fakeNow = new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  t = await createTestApp();
  const clock = { now: () => fakeNow };
  const runner = new MikroOrmTransactionRunner(t.app.get(MikroORM));
  const useCase = new SubmitWagerTransaction(runner, clock, new UuidV7Generator());
  worker = new PendingReferenceWorker(runner, useCase, clock);
});

afterAll(async () => {
  await t?.close();
});

const advance = (ms: number) => (fakeNow = new Date(fakeNow.getTime() + ms));

async function processedBet(amount = "30.00", roundId = "round-1") {
  const w = await openWallet(t.baseUrl, "100.00");
  const bet = wager({ ...w, amount, roundId });
  const res = await postWager(t.baseUrl, bet);
  expect(res.body.status).toBe("PROCESSED");
  return { w, bet };
}

describe("reversões", () => {
  test("REFUND de BET processada → crédito, saldo volta", async () => {
    const { w, bet } = await processedBet();
    const res = await postWager(t.baseUrl, wager({ ...w, kind: "REFUND", amount: "30.00", referenceExternalTransactionId: bet.externalTransactionId }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    expect(await countLedger(t.sql, w.walletId, "CREDIT")).toBe(2);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("ROLLBACK de WIN → débito", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const win = wager({ ...w, kind: "WIN", amount: "40.00" });
    await postWager(t.baseUrl, win);
    const res = await postWager(t.baseUrl, wager({ ...w, kind: "ROLLBACK", amount: "40.00", referenceExternalTransactionId: win.externalTransactionId }));
    expect(res.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("ROLLBACK de WIN já gasto → 422 REVERSAL_INSUFFICIENT_FUNDS", async () => {
    const w = await openWallet(t.baseUrl, "0.00");
    const win = wager({ ...w, kind: "WIN", amount: "40.00" });
    await postWager(t.baseUrl, win);
    await postWager(t.baseUrl, wager({ ...w, amount: "30.00" }));
    const res = await postWager(t.baseUrl, wager({ ...w, kind: "ROLLBACK", amount: "40.00", referenceExternalTransactionId: win.externalTransactionId }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("REFUND e depois ROLLBACK da mesma BET → segundo é 422 REFERENCE_ALREADY_REVERSED", async () => {
    const { w, bet } = await processedBet();
    const ref = { referenceExternalTransactionId: bet.externalTransactionId, amount: "30.00" };
    expect((await postWager(t.baseUrl, wager({ ...w, kind: "REFUND", ...ref }))).status).toBe(200);
    const second = await postWager(t.baseUrl, wager({ ...w, kind: "ROLLBACK", ...ref }));
    expect(second.status).toBe(422);
    expect(second.body.code).toBe("REFERENCE_ALREADY_REVERSED");
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("100.00");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("dois REFUND concorrentes da mesma BET → exatamente um PROCESSED", async () => {
    const { w, bet } = await processedBet();
    const refund = () => postWager(t.baseUrl, wager({ ...w, kind: "REFUND", amount: "30.00", referenceExternalTransactionId: bet.externalTransactionId }));
    const results = await Promise.all([refund(), refund(), refund()]);
    expect(results.filter((r) => r.body.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((r) => r.body.code === "REFERENCE_ALREADY_REVERSED")).toHaveLength(2);
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("100.00");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("REFUND com valor diferente da BET → 422 REFERENCE_AMOUNT_MISMATCH", async () => {
    const { w, bet } = await processedBet();
    const res = await postWager(t.baseUrl, wager({ ...w, kind: "REFUND", amount: "10.00", referenceExternalTransactionId: bet.externalTransactionId }));
    expect(res.body.code).toBe("REFERENCE_AMOUNT_MISMATCH");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("WIN com referência a BET de outra rodada → REFERENCE_MISMATCH", async () => {
    const { w, bet } = await processedBet("30.00", "round-A");
    const res = await postWager(t.baseUrl, wager({ ...w, kind: "WIN", amount: "60.00", roundId: "round-B", referenceExternalTransactionId: bet.externalTransactionId }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("REFERENCE_MISMATCH");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("WIN com referência a BET da mesma rodada → crédito", async () => {
    const { w, bet } = await processedBet("30.00", "round-A");
    const res = await postWager(t.baseUrl, wager({ ...w, kind: "WIN", amount: "60.00", roundId: "round-A", referenceExternalTransactionId: bet.externalTransactionId }));
    expect(res.body).toMatchObject({ status: "PROCESSED", balance: { amount: "130.00" } });
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });
});

describe("referências fora de ordem", () => {
  test("REFUND chega antes da BET → 202; BET chega; worker resolve; replay devolve PROCESSED", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const bet = wager({ ...w, amount: "30.00" });
    const refund = wager({ ...w, kind: "REFUND", amount: "30.00", referenceExternalTransactionId: bet.externalTransactionId });

    const early = await postWager(t.baseUrl, refund);
    expect(early.status).toBe(202);
    expect(early.body).toMatchObject({ status: "PENDING_REFERENCE", balance: { amount: "100.00" } });
    const pendingEvents = await t.sql(`select event_type from outbox_messages where payload->'data'->>'transactionId' = $1`, [early.body.transactionId]);
    expect(pendingEvents).toEqual([{ event_type: "WagerTransactionPendingReference" }]);

    expect((await postWager(t.baseUrl, bet)).body.balance.amount).toBe("70.00");
    await worker.tick();

    const replay = await postWager(t.baseUrl, refund);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: early.body.transactionId, status: "PROCESSED", balance: { amount: "100.00" }, idempotentReplay: true });
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("100.00");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("referência nunca chega → após 10 tentativas → REJECTED REFERENCE_NOT_FOUND + evento", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, kind: "ROLLBACK", amount: "5.00", referenceExternalTransactionId: "never-arrives" });
    const res = await postWager(t.baseUrl, cmd);
    expect(res.status).toBe(202);
    const id = res.body.transactionId;
    const state = async () => (await t.sql(`select status, failure_code, reference_attempts from wager_transactions where id = $1`, [id]))[0];

    for (let i = 0; i < 9; i++) {
      advance(61_000);
      await worker.tick();
    }
    expect(await state()).toEqual({ status: "PENDING_REFERENCE", failure_code: null, reference_attempts: 9 });

    advance(61_000);
    await worker.tick();
    expect(await state()).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND" });
    const events = await t.sql(`select event_type from outbox_messages where payload->'data'->>'transactionId' = $1 order by seq`, [id]);
    expect(events.map((e) => e.event_type)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);

    const replay = await postWager(t.baseUrl, cmd);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ code: "REFERENCE_NOT_FOUND", idempotentReplay: true });
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("worker não reprocessa antes do horário agendado", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const res = await postWager(t.baseUrl, wager({ ...w, kind: "REFUND", amount: "5.00", referenceExternalTransactionId: "later" }));
    advance(61_000);
    await worker.tick();
    await worker.tick();
    const [row] = await t.sql(`select reference_attempts from wager_transactions where id = $1`, [res.body.transactionId]);
    expect(row.reference_attempts).toBe(1);
  });
});

describe("papel pending", () => {
  test("com APP_ROLES=pending o worker roda sozinho e o app encerra sem travar", async () => {
    const app = await createTestApp({ APP_ROLES: "api,pending" });
    try {
      const w = await openWallet(app.baseUrl, "10.00");
      const res = await postWager(app.baseUrl, wager({ ...w, kind: "REFUND", amount: "1.00", referenceExternalTransactionId: "missing" }));
      const attempts = async () => (await app.sql(`select reference_attempts from wager_transactions where id = $1`, [res.body.transactionId]))[0].reference_attempts;
      const deadline = Date.now() + 8_000;
      while ((await attempts()) === 0 && Date.now() < deadline) await Bun.sleep(200);
      expect(await attempts()).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });
});
