import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { TransientInfraError } from "../../src/application/errors";
import type { Metrics, MetricName, TransactionRunner } from "../../src/application/ports";
import { SubmitWagerTransaction, type SubmitWagerCommand } from "../../src/application/submit-wager-transaction";
import { FailureCode } from "../../src/domain/failure-code";
import { loadConfig } from "../../src/infrastructure/config";
import { WagerConsumer } from "../../src/infrastructure/messaging/wager-consumer";
import { MikroOrmTransactionRunner } from "../../src/infrastructure/persistence/transaction-runner";
import { SystemClock, UuidV7Generator } from "../../src/infrastructure/system";
import { createTestApp, type TestApp } from "../support/test-app";
import { assertLedgerMatchesBalance } from "../support/invariants";
import { countLedger, getWallet, openWallet, wager } from "../support/factories";
import { createTestQueues, receiveAll, sendRaw, sqs, type TestQueues } from "../support/sqs";
import { spawnInstance } from "../support/spawn-instance";

let t: TestApp;
let queues: TestQueues;
let runner: MikroOrmTransactionRunner;

class CountingMetrics implements Metrics {
  readonly counts: { name: MetricName; labels?: Record<string, string> }[] = [];
  inc(name: MetricName, labels?: Record<string, string>) {
    this.counts.push({ name, labels });
  }
  observe() {}
  setOutboxLag() {}
  count(name: MetricName) {
    return this.counts.filter((c) => c.name === name).length;
  }
}

beforeAll(async () => {
  queues = await createTestQueues("consumer", { maxReceiveCount: 3, visibilityTimeoutSeconds: 2 });
  t = await createTestApp(queues.env);
  runner = new MikroOrmTransactionRunner(t.app.get(MikroORM));
});

afterAll(async () => {
  await t?.close();
});

const config = () => loadConfig({ ...process.env, ...queues.env, DATABASE_URL: t.databaseUrl });

function consumerWith(opts: { submit?: SubmitWagerTransaction; metrics?: Metrics; runner?: TransactionRunner } = {}) {
  const submit = opts.submit ?? new SubmitWagerTransaction(opts.runner ?? runner, new SystemClock(), new UuidV7Generator());
  return new WagerConsumer(sqs, config(), submit, opts.metrics ?? new CountingMetrics(), { hit: () => {} }, { waitTimeSeconds: 1 });
}

// envelope da spec; o messageId de negócio é independente do id de dedup do SQS
function envelope(cmd: SubmitWagerCommand, messageId: string = crypto.randomUUID()) {
  const { idempotencyKey, ...fields } = cmd;
  return { messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data: { ...fields, idempotencyKey } };
}

const send = (body: unknown, groupId = "g") => sendRaw(queues.wagerQueueName, typeof body === "string" ? body : JSON.stringify(body), groupId, crypto.randomUUID());

// processa até a fila esvaziar ou o tempo acabar
async function drain(consumer: WagerConsumer, ms: number, until?: () => Promise<boolean>) {
  const deadline = Date.now() + ms;
  const outcomes: string[] = [];
  while (Date.now() < deadline) {
    outcomes.push(...(await consumer.pollOnce()));
    if (until && (await until())) break;
  }
  return outcomes;
}

const txCount = async (key: string) => (await t.sql(`select count(*)::int as n from wager_transactions where idempotency_key = $1`, [key]))[0].n;

describe("WagerConsumer", () => {
  test("mensagem válida → transação PROCESSED, mensagem removida da fila", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "25.00" });
    await send(envelope(cmd), w.walletId);

    const outcomes = await drain(consumerWith(), 5_000, async () => (await txCount(cmd.idempotencyKey)) === 1);
    expect(outcomes).toContain("acked");
    const [row] = await t.sql(`select status from wager_transactions where idempotency_key = $1`, [cmd.idempotencyKey]);
    expect(row.status).toBe("PROCESSED");
    expect(await receiveAll(queues.wagerQueueName, 3_000)).toEqual([]);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("mesma mensagem enviada 2× (messageIds iguais) → 1 transação, métrica de duplicata", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "10.00" });
    const message = envelope(cmd);
    await send(message, w.walletId);
    await send(message, w.walletId);

    const metrics = new CountingMetrics();
    await drain(consumerWith({ metrics }), 6_000, async () => metrics.count("duplicates_total") >= 1);
    expect(await txCount(cmd.idempotencyKey)).toBe(1);
    expect(metrics.counts).toContainEqual({ name: "duplicates_total", labels: { source: "inbox" } });
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("mesma operação com messageIds diferentes → 1 transação (a segunda vira replay)", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "10.00" });
    const [a, b] = [envelope(cmd), envelope(cmd)];
    await send(a, w.walletId);
    await send(b, w.walletId);

    const inboxRows = async () => (await t.sql(`select count(*)::int as n from inbox_messages where message_id in ($1, $2)`, [a.messageId, b.messageId]))[0].n;
    await drain(consumerWith(), 6_000, async () => (await inboxRows()) === 2);
    expect(await inboxRows()).toBe(2);
    expect(await txCount(cmd.idempotencyKey)).toBe(1);
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("inbox atômico: falha antes do commit não deixa linha em inbox_messages", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const message = envelope(wager({ ...w, amount: "10.00" }));
    await send(message, w.walletId);
    const failing: TransactionRunner = {
      run: (work) =>
        runner.run(async (repos) => {
          await work(repos);
          throw new TransientInfraError(FailureCode.DATABASE_UNAVAILABLE, "connection lost before commit");
        }),
    };

    const outcomes = await drain(consumerWith({ runner: failing }), 3_000, async () => true);
    expect(outcomes).toEqual(["retry"]);
    expect(await t.sql(`select 1 from inbox_messages where message_id = $1`, [message.messageId])).toEqual([]);
    // depois volta ao normal e a mesma mensagem é processada
    await drain(consumerWith(), 8_000, async () => (await t.sql(`select 1 from inbox_messages where message_id = $1`, [message.messageId])).length === 1);
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("90.00");
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  });

  test("mesmo messageId com payload diferente → vai para a DLQ", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const original = envelope(wager({ ...w, amount: "10.00" }));
    await send(original, w.walletId);
    await drain(consumerWith(), 5_000, async () => (await t.sql(`select 1 from inbox_messages where message_id = $1`, [original.messageId])).length === 1);

    const tampered = { ...original, data: { ...original.data, money: { amount: "99.00", currency: "BRL" } } };
    await send(tampered, w.walletId);
    const outcomes = await drain(consumerWith(), 5_000, async () => true);
    expect(outcomes).toEqual(["dead-lettered"]);
    const dlq = await receiveAll(queues.wagerDlqName, 2_000);
    expect(dlq.map((m) => m.messageId)).toContain(original.messageId);
    expect((await getWallet(t.baseUrl, w.walletId)).balance.amount).toBe("90.00");
  });

  test("JSON inválido → DLQ imediatamente, sem retry", async () => {
    await send("{not json", "g-invalid");
    const metrics = new CountingMetrics();
    const outcomes = await drain(consumerWith({ metrics }), 3_000, async () => true);
    expect(outcomes).toEqual(["dead-lettered"]);
    expect(metrics.count("dlq_messages_total")).toBe(1);
    expect(metrics.count("retries_total")).toBe(0);
    expect(await receiveAll(queues.wagerDlqName, 2_000)).toHaveLength(1);
  });

  test("BET sem saldo → REJECTED e ack (não vai para a DLQ)", async () => {
    const w = await openWallet(t.baseUrl, "5.00");
    const cmd = wager({ ...w, amount: "10.00" });
    await send(envelope(cmd), w.walletId);
    const outcomes = await drain(consumerWith(), 5_000, async () => (await txCount(cmd.idempotencyKey)) === 1);
    expect(outcomes).toEqual(["acked"]);
    const [row] = await t.sql(`select status, failure_code from wager_transactions where idempotency_key = $1`, [cmd.idempotencyKey]);
    expect(row).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await receiveAll(queues.wagerDlqName, 1_500)).toEqual([]);
  });

  test("wallet inexistente → DLQ (não some com um ack)", async () => {
    await send(envelope(wager({ amount: "1.00" })), "g-missing");
    expect(await drain(consumerWith(), 3_000, async () => true)).toEqual(["dead-lettered"]);
    expect(await receiveAll(queues.wagerDlqName, 2_000)).toHaveLength(1);
  });

  test("transitório 2× → processada na 3ª entrega", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "10.00" });
    const real = new SubmitWagerTransaction(runner, new SystemClock(), new UuidV7Generator());
    let calls = 0;
    const flaky = Object.assign(Object.create(real), {
      execute: (...args: Parameters<SubmitWagerTransaction["execute"]>) => {
        calls += 1;
        if (calls <= 2) return Promise.reject(new TransientInfraError(FailureCode.LOCK_TIMEOUT, "simulated"));
        return real.execute(...args);
      },
    }) as SubmitWagerTransaction;
    await send(envelope(cmd), w.walletId);

    const outcomes = await drain(consumerWith({ submit: flaky }), 20_000, async () => (await txCount(cmd.idempotencyKey)) === 1);
    expect(outcomes.filter((o) => o === "retry")).toHaveLength(2);
    expect(outcomes).toContain("acked");
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  }, 30_000);

  test("transitório sempre → termina na DLQ após 3 recebimentos", async () => {
    const real = new SubmitWagerTransaction(runner, new SystemClock(), new UuidV7Generator());
    const broken = Object.assign(Object.create(real), {
      execute: () => Promise.reject(new TransientInfraError(FailureCode.DATABASE_UNAVAILABLE, "simulated")),
    }) as SubmitWagerTransaction;
    const message = envelope(wager({ amount: "1.00" }));
    await send(message, "g-always");

    const metrics = new CountingMetrics();
    const outcomes = await drain(consumerWith({ submit: broken, metrics }), 25_000, async () => metrics.count("dlq_messages_total") === 1);
    expect(outcomes).toEqual(["retry", "retry", "dead-lettered"]);
    const dlq = await receiveAll(queues.wagerDlqName, 2_000);
    expect(dlq.map((m) => m.messageId)).toEqual([message.messageId]);
  }, 40_000);

  test("worker morto depois do commit e antes do ack → reentrega não duplica o efeito", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "30.00" });
    const message = envelope(cmd);
    const env = { ...queues.env, DATABASE_URL: t.databaseUrl, APP_ROLES: "consumer" };

    const crashing = await spawnInstance({ ...env, FAULT_POINT: "after-commit-before-ack" }, { waitReady: false });
    await send(message, w.walletId);
    expect(await crashing.exited).toBe(137);
    expect(await txCount(cmd.idempotencyKey)).toBe(1);

    // outra instância recebe a reentrega depois do visibility timeout
    const healthy = await spawnInstance(env);
    try {
      await Bun.sleep(5_000);
    } finally {
      healthy.kill("SIGKILL");
      await healthy.exited;
    }

    expect(await txCount(cmd.idempotencyKey)).toBe(1);
    expect(await countLedger(t.sql, w.walletId, "DEBIT")).toBe(1);
    expect(await t.sql(`select count(*)::int as n from inbox_messages where message_id = $1`, [message.messageId])).toEqual([{ n: 1 }]);
    expect(await receiveAll(queues.wagerQueueName, 3_000)).toEqual([]);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  }, 60_000);

  test("shutdown com mensagem em processamento → termina a mensagem antes de parar", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "10.00" });
    const real = new SubmitWagerTransaction(runner, new SystemClock(), new UuidV7Generator());
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const slow = Object.assign(Object.create(real), {
      execute: async (...args: Parameters<SubmitWagerTransaction["execute"]>) => {
        started();
        await Bun.sleep(1_500);
        return real.execute(...args);
      },
    }) as SubmitWagerTransaction;

    const consumer = new WagerConsumer(sqs, config(), slow, new CountingMetrics(), { hit: () => {} }, { enabled: true, waitTimeSeconds: 1 });
    consumer.onApplicationBootstrap();
    await send(envelope(cmd), w.walletId);
    await inFlight;
    await consumer.onModuleDestroy();

    expect(await txCount(cmd.idempotencyKey)).toBe(1);
    expect(await receiveAll(queues.wagerQueueName, 3_000)).toEqual([]);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  }, 30_000);

  // no Windows não existe SIGTERM de verdade (kill encerra o processo na hora)
  test.skipIf(process.platform === "win32")("SIGTERM → processo encerra com código 0", async () => {
    const instance = await spawnInstance({ ...queues.env, DATABASE_URL: t.databaseUrl, APP_ROLES: "api,consumer" });
    instance.kill("SIGTERM");
    expect(await instance.exited).toBe(0);
  }, 30_000);
});

describe("banco fora do ar", () => {
  test("queda maior que a janela de retries → consumidor pausa e a mensagem não vai para a DLQ", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "10.00" });
    const message = envelope(cmd);
    const real = new SubmitWagerTransaction(runner, new SystemClock(), new UuidV7Generator());
    let databaseDown = true;
    const submit = Object.assign(Object.create(real), {
      execute: (...args: Parameters<SubmitWagerTransaction["execute"]>) =>
        databaseDown ? Promise.reject(new TransientInfraError(FailureCode.DATABASE_UNAVAILABLE, "simulated outage")) : real.execute(...args),
    }) as SubmitWagerTransaction;

    const consumer = new WagerConsumer(sqs, config(), submit, new CountingMetrics(), { hit: () => {} }, {
      enabled: true,
      waitTimeSeconds: 1,
      isDatabaseUp: async () => !databaseDown,
    });
    consumer.onApplicationBootstrap();
    try {
      await send(message, w.walletId);
      // sem a pausa, com maxReceiveCount 3 e backoff 2 s + 4 s, a mensagem iria para a DLQ em ~6 s
      await Bun.sleep(9_000);
      databaseDown = false;
      const deadline = Date.now() + 15_000;
      while ((await txCount(cmd.idempotencyKey)) === 0 && Date.now() < deadline) await Bun.sleep(250);
    } finally {
      await consumer.onModuleDestroy();
    }

    expect(await txCount(cmd.idempotencyKey)).toBe(1);
    expect((await receiveAll(queues.wagerDlqName, 1_500)).map((m) => m.messageId)).not.toContain(message.messageId);
    await assertLedgerMatchesBalance(t.sql, w.walletId);
  }, 40_000);
});
