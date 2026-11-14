import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, getJson, postJson, type TestApp } from "../support/test-app";
import { assertLedgerMatchesBalance } from "../support/invariants";
import { openWallet, postWager, wager } from "../support/factories";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe("consulta de transações", () => {
  test("por id e por external id devolvem a mesma transação", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "25.00" });
    const created = await postWager(t.baseUrl, cmd);

    const byId = await getJson(`${t.baseUrl}/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: created.body.transactionId,
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      walletId: w.walletId,
      kind: "BET",
      status: "PROCESSED",
      money: { amount: "25.00", currency: "BRL" },
      balance: { amount: "75.00", currency: "BRL" },
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });

    const byExternal = await getJson(`${t.baseUrl}/providers/${cmd.providerId}/wagering/transactions/${cmd.externalTransactionId}`);
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
  });

  test("rejeitada mostra o failureCode", async () => {
    const w = await openWallet(t.baseUrl, "1.00");
    const created = await postWager(t.baseUrl, wager({ ...w, amount: "25.00" }));
    const res = await getJson(`${t.baseUrl}/wagering/transactions/${created.body.transactionId}`);
    expect(res.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
  });

  test("inexistente → 404 TRANSACTION_NOT_FOUND", async () => {
    expect((await getJson(`${t.baseUrl}/wagering/transactions/${crypto.randomUUID()}`)).body.code).toBe("TRANSACTION_NOT_FOUND");
    const res = await getJson(`${t.baseUrl}/providers/provider-a/wagering/transactions/nope`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("TRANSACTION_NOT_FOUND");
  });

  test("id não-UUID → 400 INVALID_PAYLOAD", async () => {
    const res = await getJson(`${t.baseUrl}/wagering/transactions/xyz`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });
});

describe("ledger paginado", () => {
  test("ledger com 120 lançamentos pagina em 50/50/20 sem repetir nem pular", async () => {
    const w = await openWallet(t.baseUrl, "1000.00");
    for (let i = 0; i < 119; i++) await postWager(t.baseUrl, wager({ ...w, amount: "1.00" }));

    const seen: string[] = [];
    const sizes: number[] = [];
    let url = `${t.baseUrl}/wallets/${w.walletId}/ledger`;
    for (;;) {
      const page = await getJson(url);
      expect(page.status).toBe(200);
      sizes.push(page.body.items.length);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      if (!page.body.nextCursor) break;
      url = `${t.baseUrl}/wallets/${w.walletId}/ledger?cursor=${page.body.nextCursor}`;
    }

    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
    const all = await t.sql(`select id::text from wallet_ledger_entries where wallet_id = $1 order by seq desc`, [w.walletId]);
    expect(seen).toEqual(all.map((r) => r.id));
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("itens trazem direção, valores e saldos; mais recente primeiro", async () => {
    const w = await openWallet(t.baseUrl, "10.00");
    await postWager(t.baseUrl, wager({ ...w, amount: "4.00" }));
    const page = await getJson(`${t.baseUrl}/wallets/${w.walletId}/ledger?limit=10`);
    expect(page.body.items).toEqual([
      expect.objectContaining({ direction: "DEBIT", money: { amount: "4.00", currency: "BRL" }, balanceBefore: { amount: "10.00", currency: "BRL" }, balanceAfter: { amount: "6.00", currency: "BRL" } }),
      expect.objectContaining({ direction: "CREDIT", money: { amount: "10.00", currency: "BRL" }, balanceAfter: { amount: "10.00", currency: "BRL" } }),
    ]);
    expect(page.body.nextCursor).toBeUndefined();
  });

  test("lançamento novo durante a paginação não desloca as páginas seguintes", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    for (let i = 0; i < 4; i++) await postWager(t.baseUrl, wager({ ...w, amount: "1.00" }));
    const first = await getJson(`${t.baseUrl}/wallets/${w.walletId}/ledger?limit=2`);
    await postWager(t.baseUrl, wager({ ...w, amount: "1.00" }));
    const second = await getJson(`${t.baseUrl}/wallets/${w.walletId}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    const ids = [...first.body.items, ...second.body.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(4);
  });

  test("?cursor=lixo → 400 INVALID_PAYLOAD", async () => {
    const w = await openWallet(t.baseUrl, "1.00");
    for (const cursor of ["lixo", Buffer.from(JSON.stringify({ s: "abc" })).toString("base64url"), "%%%"]) {
      const res = await getJson(`${t.baseUrl}/wallets/${w.walletId}/ledger?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_PAYLOAD");
    }
  });

  test("limit inválido → 400; wallet inexistente → 404", async () => {
    const w = await openWallet(t.baseUrl, "1.00");
    for (const limit of ["0", "201", "abc"]) {
      expect((await getJson(`${t.baseUrl}/wallets/${w.walletId}/ledger?limit=${limit}`)).status).toBe(400);
    }
    expect((await getJson(`${t.baseUrl}/wallets/${crypto.randomUUID()}/ledger`)).body.code).toBe("WALLET_NOT_FOUND");
  });
});

describe("reconciliação", () => {
  test("reconciliação de wallet sã → consistent true, difference 0.00", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    await postWager(t.baseUrl, wager({ ...w, amount: "25.00" }));
    const res = await postJson(`${t.baseUrl}/wallets/${w.walletId}/reconciliation`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.walletId,
      storedBalance: { amount: "75.00", currency: "BRL" },
      calculatedBalance: { amount: "75.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("divergência forçada → consistent false, difference correto, saldo não foi alterado", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    // simula corrupção: desliga os triggers só nesta sessão para conseguir gravar um saldo errado
    await t.sql(`set session_replication_role = replica; update wallets set balance = 90.00 where id = '${w.walletId}'; set session_replication_role = origin;`);

    const res = await postJson(`${t.baseUrl}/wallets/${w.walletId}/reconciliation`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storedBalance: { amount: "90.00" },
      calculatedBalance: { amount: "100.00" },
      difference: { amount: "-10.00", currency: "BRL" },
      consistent: false,
      checkedEntries: 1,
    });
    const [row] = await t.sql(`select balance::text from wallets where id = $1`, [w.walletId]);
    expect(row.balance).toBe("90.00");
  });

  test("wallet inexistente → 404 WALLET_NOT_FOUND", async () => {
    const res = await postJson(`${t.baseUrl}/wallets/${crypto.randomUUID()}/reconciliation`, {});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("WALLET_NOT_FOUND");
  });
});

describe("cursor fora do intervalo", () => {
  test("seq acima do bigint → 400 INVALID_PAYLOAD (não 500)", async () => {
    const w = await openWallet(t.baseUrl, "1.00");
    const cursor = Buffer.from(JSON.stringify({ s: "9999999999999999999" })).toString("base64url");
    const res = await getJson(`${t.baseUrl}/wallets/${w.walletId}/ledger?cursor=${cursor}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });
});
