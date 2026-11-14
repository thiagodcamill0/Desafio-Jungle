import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, type TestApp } from "../support/test-app";
import { assertLedgerMatchesBalance } from "../support/invariants";
import { countLedger, getWallet, openWallet, postWager, wager } from "../support/factories";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe("concorrência na mesma instância", () => {
  test("cenário obrigatório: 100.00 e duas BET de 80.00 simultâneas", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const [a, b] = await Promise.all([
      postWager(t.baseUrl, wager({ ...w, amount: "80.00" })),
      postWager(t.baseUrl, wager({ ...w, amount: "80.00" })),
    ]);
    expect([a.body.status, b.body.status].sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect([a.body, b.body].find((r) => r.status === "REJECTED").failureCode).toBe("INSUFFICIENT_FUNDS");
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("20.00");
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("mesma BET 50× em paralelo → 1 débito, 49 replays", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "10.00" });
    const results = await Promise.all(Array.from({ length: 50 }, () => postWager(t.baseUrl, cmd)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.balance.amount))).toEqual(new Set(["90.00"]));
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("90.00");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("10 wallets × 20 BETs em paralelo → cada wallet consistente", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(t.baseUrl, "100.00")));
    const requests = wallets.flatMap((w) => Array.from({ length: 20 }, () => postWager(t.baseUrl, wager({ ...w, amount: "7.00" }))));
    const results = await Promise.all(requests);

    expect(results.every((r) => r.status === 200 || r.status === 422)).toBe(true);
    for (const w of wallets) {
      // 100 / 7 = 14 apostas cabem; as outras 6 são rejeitadas
      expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(14);
      expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("2.00");
      await assertLedgerMatchesBalance(t.sql, w.walletId);
    }
  });
});
