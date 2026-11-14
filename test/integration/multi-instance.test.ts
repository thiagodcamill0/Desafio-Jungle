import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../support/test-db";
import { assertLedgerMatchesBalance } from "../support/invariants";
import { countLedger, getWallet, openWallet, postWager, wager } from "../support/factories";
import { postJson } from "../support/test-app";
import { createTestQueues, sendRaw, type TestQueues } from "../support/sqs";
import { spawnInstance, type Instance } from "../support/spawn-instance";

let db: TestDatabase;
let queues: TestQueues;
let instances: Instance[] = [];
let env: Record<string, string>;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues("multi", { visibilityTimeoutSeconds: 5 });
  env = { ...queues.env, DATABASE_URL: db.url, APP_ROLES: "api,consumer,outbox,pending", LOG_LEVEL: "warn" };
  instances = await Promise.all([spawnInstance(env), spawnInstance(env), spawnInstance(env)]);
}, 60_000);

afterAll(async () => {
  for (const instance of instances) instance.kill("SIGKILL");
  await Promise.all(instances.map((i) => i.exited));
  await db?.drop();
});

const urls = () => instances.map((i) => i.baseUrl);

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const pendingOutbox = async () => (await db.sql(`select count(*)::int as n from outbox_messages where published_at is null`))[0].n as number;

describe("três instâncias", () => {
  test("cenário 100/80/80 com as duas BETs em instâncias diferentes → 1 PROCESSED, 1 REJECTED, saldo 20.00", async () => {
    const [a, b] = urls();
    const w = await openWallet(a!, "100.00");
    const [r1, r2] = await Promise.all([postWager(a!, wager({ ...w, amount: "80.00" })), postWager(b!, wager({ ...w, amount: "80.00" }))]);

    expect([r1.body.status, r2.body.status].sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect([r1.body, r2.body].find((r) => r.status === "REJECTED").failureCode).toBe("INSUFFICIENT_FUNDS");
    expect((await getWallet(a!, w.walletId)).balance.amount).toBe("20.00");
    expect(await countLedger(db.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(db.sql, w.walletId);
  });

  test("mesma BET 50× distribuída em round-robin → 1 débito", async () => {
    const w = await openWallet(urls()[0]!, "100.00");
    const cmd = wager({ ...w, amount: "10.00" });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => postWager(urls()[i % 3]!, cmd)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await countLedger(db.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(db.sql, w.walletId);
  });

  test("3 instâncias + SQS: 200 mensagens (20 wallets) com duplicadas → cada operação processada uma vez", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => openWallet(urls()[i % 3]!, "100.00")));
    const envelopes = wallets.flatMap((w) =>
      Array.from({ length: 10 }, () => {
        const { idempotencyKey, ...fields } = wager({ ...w, amount: "1.00" });
        return { groupId: w.walletId, body: { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data: { ...fields, idempotencyKey } } };
      }),
    );
    // 30 mensagens reenviadas: mesmo messageId, novo id de dedup no SQS (como uma redelivery tardia)
    const duplicates = envelopes.filter((_, i) => i % 7 === 0).slice(0, 30);
    await Promise.all([...envelopes, ...duplicates].map((m) => sendRaw(queues.wagerQueueName, JSON.stringify(m.body), m.groupId, crypto.randomUUID())));

    const ids = wallets.map((w) => w.walletId);
    const processed = async () => (await db.sql(`select count(*)::int as n from wager_transactions where wallet_id = any($1::uuid[]) and kind = 'BET'`, [ids]))[0].n;
    await waitFor(async () => (await processed()) === 200, 90_000, "200 transactions");
    await Bun.sleep(1_000);

    expect(await processed()).toBe(200);
    for (const w of wallets) {
      expect(await countLedger(db.sql, w.walletId, "DEBIT")).toBe(10);
      expect((await getWallet(urls()[0]!, w.walletId)).balance.amount).toBe("90.00");
      await assertLedgerMatchesBalance(db.sql, w.walletId);
    }
    const inbox = await db.sql(`select count(*)::int as n from inbox_messages where message_id = any($1::text[])`, [envelopes.map((m) => m.body.messageId)]);
    expect(inbox[0].n).toBe(200);
  }, 120_000);

  test("kill -9 numa instância no meio da carga, sobe de novo → reconciliação consistente e outbox zerada", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => openWallet(urls()[i % 3]!, "100.00")));
    const load = Promise.all(
      Array.from({ length: 300 }, (_, i) => {
        const w = wallets[i % wallets.length]!;
        return postWager(urls()[i % 3]!, wager({ ...w, amount: "3.00" })).catch(() => null);
      }),
    );
    await Bun.sleep(150);
    const victim = instances[1]!;
    victim.kill("SIGKILL");
    await victim.exited;
    await load;

    instances[1] = await spawnInstance(env);
    await waitFor(async () => (await pendingOutbox()) === 0, 60_000, "outbox drained");

    for (const w of wallets) {
      const report = await postJson(`${urls()[0]}/wallets/${w.walletId}/reconciliation`, {});
      expect(report.status).toBe(200);
      expect(report.body.consistent).toBe(true);
      await assertLedgerMatchesBalance(db.sql, w.walletId);
      // nenhuma transação ficou no meio do caminho
      const stuck = await db.sql(`select count(*)::int as n from wager_transactions where wallet_id = $1 and status = 'PENDING'`, [w.walletId]);
      expect(stuck[0].n).toBe(0);
    }
    expect(await pendingOutbox()).toBe(0);
  }, 120_000);
});
