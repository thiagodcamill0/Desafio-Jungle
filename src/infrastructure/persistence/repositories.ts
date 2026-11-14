import { LockMode, type EntityManager } from "@mikro-orm/postgresql";
import { ConcurrencyError } from "../../application/errors";
import type {
  InboxInsertResult,
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  Metrics,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports";
import type { InboxMessage } from "../../domain/inbox-message";
import type { Money } from "../../domain/money";
import type { OutboxMessage } from "../../domain/outbox-message";
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { inboxMapper, ledgerMapper, moneyFromDb, outboxMapper, transactionMapper, walletMapper } from "./mappers";
import { InboxSchema, LedgerEntrySchema, OutboxSchema, WagerTransactionSchema, WalletSchema } from "./schemas";

// sem identity map: toda leitura vai ao banco
const fresh = { disableIdentityMap: true } as const;
const forUpdate = { ...fresh, lockMode: LockMode.PESSIMISTIC_WRITE } as const;
const skipLocked = { ...fresh, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE } as const;

const SLOW_LOCK_WAIT_MS = 100;

class MikroOrmWalletRepository implements WalletRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics?: Metrics,
  ) {}

  // mede a espera pelo lock: espera longa indica wallet disputada
  async lockById(id: string): Promise<Wallet | null> {
    const started = performance.now();
    const row = await this.em.findOne(WalletSchema, { id }, forUpdate);
    if (performance.now() - started > SLOW_LOCK_WAIT_MS) this.metrics?.inc("lock_conflicts_total", { reason: "slow_wait" });
    return row ? walletMapper.toDomain(row) : null;
  }

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletSchema, { id }, fresh);
    return row ? walletMapper.toDomain(row) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletMapper.toRow(wallet));
  }

  async save(wallet: Wallet): Promise<void> {
    const { balance, version, updatedAt } = walletMapper.toRow(wallet);
    const updated = await this.em.nativeUpdate(WalletSchema, { id: wallet.id, version: version - 1 }, { balance, version, updatedAt });
    if (updated === 0) throw new ConcurrencyError(`Wallet ${wallet.id} changed concurrently (expected version ${version - 1})`);
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string) {
    return this.findOne({ id });
  }

  async lockById(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, { id }, forUpdate);
    return row ? transactionMapper.toDomain(row) : null;
  }

  findByIdempotencyKey(idempotencyKey: string) {
    return this.findOne({ idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string) {
    return this.findOne({ providerId, externalTransactionId });
  }

  findProcessedReversalOf(transactionId: string) {
    return this.findOne({
      referenceTransactionId: transactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
  }

  // cada worker pega um lote diferente; linhas travadas por outro worker são puladas
  async claimDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { ...skipLocked, fields: ["id"], orderBy: { nextReferenceAttemptAt: "asc" }, limit },
    );
    return rows.map((row) => row.id);
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, transactionMapper.toRow(tx));
  }

  async save(tx: WagerTransaction): Promise<void> {
    const { id, ...changes } = transactionMapper.toRow(tx);
    await this.em.nativeUpdate(WagerTransactionSchema, { id }, changes);
  }

  private async findOne(where: Parameters<EntityManager["findOne"]>[1]): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, where as never, fresh);
    return row ? transactionMapper.toDomain(row) : null;
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerMapper.toRow(entry));
  }

  // busca um a mais para saber se existe próxima página
  async listByWallet(walletId: string, page: { beforeSeq?: bigint; limit: number }): Promise<LedgerPage> {
    const where = page.beforeSeq === undefined ? { walletId } : { walletId, seq: { $lt: page.beforeSeq } };
    const rows = await this.em.find(LedgerEntrySchema, where, { ...fresh, orderBy: { seq: "desc" }, limit: page.limit + 1 });
    const visible = rows.slice(0, page.limit);
    const hasMore = rows.length > page.limit;
    return { entries: visible.map(ledgerMapper.toDomain), lastSeq: hasMore ? BigInt(visible.at(-1)!.seq!) : undefined };
  }

  async computeBalance(walletId: string, currency: string): Promise<{ balance: Money; count: number }> {
    const [row] = await this.em.execute<{ total: string; count: string }[]>(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text as total,
              count(*)::text as count
         from wallet_ledger_entries where wallet_id = ?`,
      [walletId],
    );
    return { balance: moneyFromDb(row!.total, currency), count: Number(row!.count) };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<InboxInsertResult> {
    const row = inboxMapper.toRow(message);
    const inserted = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?) on conflict do nothing returning message_id`,
      [row.consumerName, row.messageId, row.payloadHash, row.receivedAt, row.processedAt],
    );
    if (inserted.length > 0) return { inserted: true };
    const existing = await this.em.findOneOrFail(InboxSchema, { consumerName: row.consumerName, messageId: row.messageId }, fresh);
    return { inserted: false, payloadHash: existing.payloadHash };
  }

  async save(message: InboxMessage): Promise<void> {
    const { consumerName, messageId, processedAt } = inboxMapper.toRow(message);
    await this.em.nativeUpdate(InboxSchema, { consumerName, messageId }, { processedAt });
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxSchema, outboxMapper.toRow(message));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxSchema,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { ...skipLocked, orderBy: { seq: "asc" }, limit },
    );
    return rows.map(outboxMapper.toDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    const { id, attempts, nextAttemptAt, publishedAt } = outboxMapper.toRow(message);
    await this.em.nativeUpdate(OutboxSchema, { id }, { attempts, nextAttemptAt, publishedAt });
  }

  async oldestPendingAgeMs(now: Date): Promise<number> {
    const [row] = await this.em.execute<{ oldest: Date | null }[]>(
      `select min(occurred_at) as oldest from outbox_messages where published_at is null`,
    );
    const oldest = row?.oldest;
    return oldest ? Math.max(0, now.getTime() - new Date(oldest).getTime()) : 0;
  }
}

export function repositoriesFor(em: EntityManager, metrics?: Metrics): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em, metrics),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
