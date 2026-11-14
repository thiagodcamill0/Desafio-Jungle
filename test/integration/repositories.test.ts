import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { mikroOrmOptions } from "../../src/infrastructure/persistence/mikro-orm.config";
import { MikroOrmTransactionRunner } from "../../src/infrastructure/persistence/transaction-runner";
import { ConcurrencyError, TransientInfraError, UniqueViolationError } from "../../src/application/errors";
import type { Repositories } from "../../src/application/ports";
import { FailureCode } from "../../src/domain/failure-code";
import { InboxMessage } from "../../src/domain/inbox-message";
import { Money } from "../../src/domain/money";
import { OutboxMessage } from "../../src/domain/outbox-message";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";
import { WalletBalanceChanged } from "../../src/domain/events/wagering-events";
import { createTestDatabase, type TestDatabase } from "../support/test-db";
import { assertLedgerMatchesBalance } from "../support/invariants";

let db: TestDatabase;
let orm: MikroORM;
let runner: MikroOrmTransactionRunner;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await MikroORM.init(mikroOrmOptions({ databaseUrl: db.url }));
  runner = new MikroOrmTransactionRunner(orm, { lockTimeoutMs: 300 });
});

afterAll(async () => {
  await orm?.close();
  await db?.drop();
});

const id = () => Bun.randomUUIDv7();
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function newWallet(): Wallet {
  return Wallet.open({ id: id(), playerId: id(), initialBalance: brl("0.00"), openingTransactionId: id(), openingEntryId: id(), at: new Date() }).wallet;
}

async function createWallet(): Promise<Wallet> {
  const wallet = newWallet();
  await runner.run((r) => r.wallets.insert(wallet));
  return wallet;
}

function winFor(wallet: Wallet, amount: string, kind = WagerTransactionKind.Win): WagerTransaction {
  const ext = id();
  return WagerTransaction.create({
    id: id(),
    providerId: "provider-a",
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    payloadHash: "hash",
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "r1",
    gameId: "g1",
    kind,
    money: brl(amount),
    createdAt: new Date(),
  });
}

// mesmo fluxo que o caso de uso fará: transação, lançamento e saldo juntos
async function credit(r: Repositories, wallet: Wallet, amount: string): Promise<WagerTransaction> {
  const tx = winFor(wallet, amount);
  await r.transactions.insert(tx);
  const entry = wallet.credit({ money: tx.money, transactionId: tx.id, entryId: id(), at: new Date() });
  tx.markProcessed(undefined, wallet.balance, new Date());
  await r.transactions.save(tx);
  await r.ledger.insert(entry);
  await r.wallets.save(wallet);
  return tx;
}

describe("wallets", () => {
  test("insert + findById reidrata Wallet igual", async () => {
    const wallet = await createWallet();
    const found = await runner.run((r) => r.wallets.findById(wallet.id));
    expect(found?.toState()).toEqual(wallet.toState());
  });

  test("save com version desatualizada lança ConcurrencyError", async () => {
    const wallet = await createWallet();
    const stale = (await runner.run((r) => r.wallets.findById(wallet.id)))!;
    await runner.run(async (r) => void (await credit(r, (await r.wallets.lockById(wallet.id))!, "10.00")));

    const attempt = runner.run(async (r) => {
      const tx = winFor(stale, "5.00");
      await r.transactions.insert(tx);
      const entry = stale.credit({ money: tx.money, transactionId: tx.id, entryId: id(), at: new Date() });
      await r.ledger.insert(entry);
      await r.wallets.save(stale);
    });
    await expect(attempt).rejects.toBeInstanceOf(ConcurrencyError);
    await assertLedgerMatchesBalance(db.sql, wallet.id);
  });

  test("lockById bloqueia segunda transação até o commit da primeira", async () => {
    const wallet = await createWallet();
    let firstLocked!: () => void;
    const locked = new Promise<void>((resolve) => (firstLocked = resolve));

    const first = runner.run(async (r) => {
      const w = (await r.wallets.lockById(wallet.id))!;
      firstLocked();
      await sleep(150);
      await credit(r, w, "10.00");
    });
    const second = (async () => {
      await locked;
      return runner.run(async (r) => {
        const w = (await r.wallets.lockById(wallet.id))!;
        const seen = w.balance.amount;
        await credit(r, w, "5.00");
        return seen;
      });
    })();

    await first;
    expect(await second).toBe("10.00");
    expect((await runner.run((r) => r.wallets.findById(wallet.id)))?.balance.amount).toBe("15.00");
    await assertLedgerMatchesBalance(db.sql, wallet.id);
  });

  test("lock que passa do lock_timeout vira TransientInfraError LOCK_TIMEOUT", async () => {
    const wallet = await createWallet();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let firstLocked!: () => void;
    const locked = new Promise<void>((resolve) => (firstLocked = resolve));

    const first = runner.run(async (r) => {
      await r.wallets.lockById(wallet.id);
      firstLocked();
      await hold;
    });
    await locked;
    const err = await runner.run((r) => r.wallets.lockById(wallet.id)).catch((e: unknown) => e);
    release();
    await first;
    expect(err).toBeInstanceOf(TransientInfraError);
    expect((err as TransientInfraError).code).toBe(FailureCode.LOCK_TIMEOUT);
  });

  test("erro 23505 vira UniqueViolationError com nome da constraint", async () => {
    const wallet = await createWallet();
    const twin = Wallet.open({ id: id(), playerId: wallet.playerId, initialBalance: brl("0.00"), openingTransactionId: id(), openingEntryId: id(), at: new Date() }).wallet;
    const err = await runner.run((r) => r.wallets.insert(twin)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UniqueViolationError);
    expect((err as UniqueViolationError).constraint).toBe("ux_wallets_player_currency");
  });
});

describe("transactions", () => {
  test("busca por idempotency key e por external id reidrata o estado", async () => {
    const wallet = await createWallet();
    const tx = await runner.run(async (r) => credit(r, (await r.wallets.lockById(wallet.id))!, "7.50"));

    const byKey = await runner.run((r) => r.transactions.findByIdempotencyKey(tx.idempotencyKey));
    const byExt = await runner.run((r) => r.transactions.findByExternalId(tx.providerId, tx.externalTransactionId));
    expect(byKey?.toState()).toEqual(tx.toState());
    expect(byExt?.id).toBe(tx.id);
    expect(byKey?.observedBalance?.amount).toBe("7.50");
  });

  test("findProcessedReversalOf encontra o REFUND processado da referência", async () => {
    const wallet = await createWallet();
    const bet = await runner.run(async (r) => credit(r, (await r.wallets.lockById(wallet.id))!, "3.00"));
    expect(await runner.run((r) => r.transactions.findProcessedReversalOf(bet.id))).toBeNull();

    const refund = WagerTransaction.create({ ...winFor(wallet, "3.00").toState(), kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: bet.externalTransactionId });
    await runner.run(async (r) => {
      const w = (await r.wallets.lockById(wallet.id))!;
      await r.transactions.insert(refund);
      const entry = w.debit({ money: refund.money, transactionId: refund.id, entryId: id(), at: new Date() });
      refund.markProcessed(bet.id, w.balance, new Date());
      await r.transactions.save(refund);
      await r.ledger.insert(entry);
      await r.wallets.save(w);
    });
    expect((await runner.run((r) => r.transactions.findProcessedReversalOf(bet.id)))?.id).toBe(refund.id);
  });

  test("claimDuePendingReferenceIds só devolve PENDING_REFERENCE vencidas", async () => {
    const wallet = await createWallet();
    const now = new Date();
    const pending = WagerTransaction.create({ ...winFor(wallet, "1.00").toState(), kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "missing" });
    pending.markPendingReference(brl("0.00"), new Date(now.getTime() - 5_000));
    await runner.run((r) => r.transactions.insert(pending));

    const ids = await runner.run((r) => r.transactions.claimDuePendingReferenceIds(now, 50));
    expect(ids).toContain(pending.id);
    const later = await runner.run((r) => r.transactions.claimDuePendingReferenceIds(new Date(now.getTime() - 10_000), 50));
    expect(later).not.toContain(pending.id);
    expect((await runner.run((r) => r.transactions.findById(pending.id)))?.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

describe("ledger", () => {
  test("listByWallet pagina do mais recente ao mais antigo e computeBalance soma os lançamentos", async () => {
    const wallet = await createWallet();
    for (const amount of ["1.00", "2.00", "3.00"]) {
      await runner.run(async (r) => void (await credit(r, (await r.wallets.lockById(wallet.id))!, amount)));
    }
    const first = await runner.run((r) => r.ledger.listByWallet(wallet.id, { limit: 2 }));
    expect(first.entries.map((e) => e.money.amount)).toEqual(["3.00", "2.00"]);
    expect(first.lastSeq).toBeDefined();
    const second = await runner.run((r) => r.ledger.listByWallet(wallet.id, { beforeSeq: first.lastSeq, limit: 2 }));
    expect(second.entries.map((e) => e.money.amount)).toEqual(["1.00"]);
    expect(second.lastSeq).toBeUndefined();

    const computed = await runner.run((r) => r.ledger.computeBalance(wallet.id, "BRL"));
    expect(computed.balance.amount).toBe("6.00");
    expect(computed.count).toBe(3);
  });
});

describe("inbox", () => {
  test("insertIfAbsent detecta duplicata e devolve o hash original", async () => {
    const message = InboxMessage.receive({ messageId: id(), consumerName: "wager-consumer", payloadHash: "h1", at: new Date() });
    expect(await runner.run((r) => r.inbox.insertIfAbsent(message))).toEqual({ inserted: true });
    const again = InboxMessage.receive({ ...message.toState(), payloadHash: "h2", at: new Date() });
    expect(await runner.run((r) => r.inbox.insertIfAbsent(again))).toEqual({ inserted: false, payloadHash: "h1" });
  });
});

describe("outbox", () => {
  async function enqueue(count: number): Promise<string[]> {
    const wallet = newWallet();
    const ids: string[] = [];
    await runner.run(async (r) => {
      for (let i = 0; i < count; i++) {
        const entry = wallet.credit({ money: brl("1.00"), transactionId: id(), entryId: id(), at: new Date() });
        const event = WalletBalanceChanged.from(wallet, entry, { eventId: id(), correlationId: "c", occurredAt: new Date(Date.now() - 1_000) });
        await r.outbox.add(OutboxMessage.enqueue(event));
        ids.push(event.eventId);
      }
    });
    return ids;
  }

  test("claimDue com dois runners em paralelo não devolve a mesma linha", async () => {
    await db.sql(`update outbox_messages set published_at = now() where published_at is null`);
    const ids = await enqueue(10);
    let arrived = 0;
    let bothClaimed!: () => void;
    const barrier = new Promise<void>((resolve) => (bothClaimed = resolve));

    const claim = () =>
      runner.run(async (r) => {
        const claimed = await r.outbox.claimDue(new Date(), 5);
        if (++arrived === 2) bothClaimed();
        await barrier;
        return claimed.map((m) => m.id);
      });
    const [a, b] = await Promise.all([claim(), claim()]);

    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(new Set([...a, ...b])).toEqual(new Set(ids));
  });

  test("save marca publicada e oldestPendingAgeMs mede o atraso", async () => {
    await db.sql(`update outbox_messages set published_at = now() where published_at is null`);
    expect(await runner.run((r) => r.outbox.oldestPendingAgeMs(new Date()))).toBe(0);
    await enqueue(1);
    expect(await runner.run((r) => r.outbox.oldestPendingAgeMs(new Date()))).toBeGreaterThanOrEqual(1_000);

    await runner.run(async (r) => {
      const [message] = await r.outbox.claimDue(new Date(), 10);
      message!.markPublished(new Date());
      await r.outbox.save(message!);
    });
    expect(await runner.run((r) => r.outbox.claimDue(new Date(), 10))).toEqual([]);
  });
});
