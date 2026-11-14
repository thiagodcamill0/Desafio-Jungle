import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { EventPublisher } from "../../src/application/ports";
import { WalletBalanceChanged } from "../../src/domain/events/wagering-events";
import { Money } from "../../src/domain/money";
import { OutboxMessage } from "../../src/domain/outbox-message";
import { Wallet } from "../../src/domain/wallet";
import { loadConfig } from "../../src/infrastructure/config";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher";
import { createSqsClient, SqsEventPublisher } from "../../src/infrastructure/messaging/sqs";
import { MikroOrmTransactionRunner } from "../../src/infrastructure/persistence/transaction-runner";
import { NoopMetrics, SystemClock } from "../../src/infrastructure/system";
import { createTestApp, type TestApp } from "../support/test-app";
import { openWallet } from "../support/factories";
import { createTestQueues, receiveAll, sqs, type TestQueues } from "../support/sqs";
import { spawnInstance } from "../support/spawn-instance";

let t: TestApp;
let queues: TestQueues;
let runner: MikroOrmTransactionRunner;
const noFaults = { hit: () => {} };

beforeAll(async () => {
  queues = await createTestQueues("outbox");
  t = await createTestApp(queues.env);
  runner = new MikroOrmTransactionRunner(t.app.get(MikroORM));
});

afterAll(async () => {
  await t?.close();
});

// cada teste começa com a outbox vazia de pendentes
beforeEach(async () => {
  await t.sql(`update outbox_messages set published_at = now() where published_at is null`);
});

const realPublisher = () => new SqsEventPublisher(sqs, queues.eventsQueueName);
const publisherWith = (events: EventPublisher) => new OutboxPublisher(runner, events, new SystemClock(), new NoopMetrics(), noFaults);

async function enqueue(count: number): Promise<string[]> {
  const wallet = Wallet.open({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7(), initialBalance: Money.zero("BRL"), openingTransactionId: "t", openingEntryId: "e", at: new Date() }).wallet;
  const ids: string[] = [];
  await runner.run(async (repos) => {
    for (let i = 0; i < count; i++) {
      const entry = wallet.credit({ money: Money.from({ amount: "1.00", currency: "BRL" }), transactionId: Bun.randomUUIDv7(), entryId: Bun.randomUUIDv7(), at: new Date() });
      const event = WalletBalanceChanged.from(wallet, entry, { eventId: Bun.randomUUIDv7(), correlationId: "c", occurredAt: new Date() });
      await repos.outbox.add(OutboxMessage.enqueue(event));
      ids.push(event.eventId);
    }
  });
  return ids;
}

describe("OutboxPublisher", () => {
  test("evento só aparece no SQS depois do commit + tick do publisher", async () => {
    const w = await openWallet(t.baseUrl, "50.00");
    const [row] = await t.sql(`select id::text from outbox_messages where aggregate_id = $1`, [w.walletId]);
    expect(await receiveAll(queues.eventsQueueName, 1_500)).toEqual([]);

    expect(await publisherWith(realPublisher()).tick()).toBe(1);
    const received = await receiveAll(queues.eventsQueueName, 2_000);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ eventId: row.id, eventType: "WalletBalanceChanged", aggregateId: w.walletId, version: 1 });
    const [after] = await t.sql(`select published_at from outbox_messages where id = $1`, [row.id]);
    expect(after.published_at).not.toBeNull();
  });

  test("dois publishers concorrentes sobre 100 mensagens → todas publicadas, soma de publish = 100", async () => {
    const ids = await enqueue(100);
    const published: string[] = [];
    const counting: EventPublisher = {
      publish: async (message) => {
        published.push(message.id);
        await Bun.sleep(2);
      },
    };
    const a = publisherWith(counting);
    const b = publisherWith(counting);
    let total = 0;
    for (let round = 0; round < 10 && total < 100; round++) {
      const [x, y] = await Promise.all([a.tick(), b.tick()]);
      total += x + y;
    }
    expect(total).toBe(100);
    expect(published).toHaveLength(100);
    expect(new Set(published)).toEqual(new Set(ids));
    expect(await t.sql(`select 1 from outbox_messages where published_at is null`)).toEqual([]);
  });

  test("falha do SQS → attempts 1 e next_attempt_at no futuro, published_at nulo", async () => {
    const [id] = await enqueue(1);
    const broken = new SqsEventPublisher(createSqsClient(loadConfig({ ...process.env, SQS_ENDPOINT: "http://127.0.0.1:1" })), queues.eventsQueueName);
    expect(await publisherWith(broken).tick()).toBe(0);
    const [row] = await t.sql(`select attempts, next_attempt_at > now() as later, published_at from outbox_messages where id = $1`, [id]);
    expect(row).toEqual({ attempts: 1, later: true, published_at: null });
  });

  test("crash após publicar e antes do commit → outra instância republica com o mesmo eventId", async () => {
    const [id] = await enqueue(1);
    const env = { ...queues.env, DATABASE_URL: t.databaseUrl, APP_ROLES: "outbox" };

    const crashing = await spawnInstance({ ...env, FAULT_POINT: "after-publish-before-commit" }, { waitReady: false });
    expect(await crashing.exited).toBe(137);
    const [pending] = await t.sql(`select published_at from outbox_messages where id = $1`, [id]);
    expect(pending.published_at).toBeNull();

    const healthy = await spawnInstance(env);
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const [row] = await t.sql(`select published_at from outbox_messages where id = $1`, [id]);
        if (row.published_at) break;
        await Bun.sleep(200);
      }
    } finally {
      healthy.kill("SIGTERM");
      await healthy.exited;
    }

    const [row] = await t.sql(`select published_at from outbox_messages where id = $1`, [id]);
    expect(row.published_at).not.toBeNull();
    const received = (await receiveAll(queues.eventsQueueName, 2_000)).filter((e) => e.eventId === id);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(new Set(received.map((e) => e.eventId))).toEqual(new Set([id]));
  }, 60_000);
});
