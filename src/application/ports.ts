import type { InboxMessage } from "../domain/inbox-message";
import type { Money } from "../domain/money";
import type { OutboxMessage } from "../domain/outbox-message";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface WalletRepository {
  // SELECT ... FOR UPDATE: segura a wallet até o fim da transação
  lockById(id: string): Promise<Wallet | null>;
  findById(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  // grava só se a versão no banco ainda for a anterior; senão ConcurrencyError
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  lockById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findProcessedReversalOf(transactionId: string): Promise<WagerTransaction | null>;
  claimDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
  insert(tx: WagerTransaction): Promise<void>;
  save(tx: WagerTransaction): Promise<void>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  // presente só quando existe próxima página
  lastSeq?: bigint;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string, page: { afterSeq?: bigint; limit: number }): Promise<LedgerPage>;
  computeBalance(walletId: string, currency: string): Promise<{ balance: Money; count: number }>;
}

export type InboxInsertResult = { inserted: true } | { inserted: false; payloadHash: string };

export interface InboxRepository {
  insertIfAbsent(message: InboxMessage): Promise<InboxInsertResult>;
  save(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  oldestPendingAgeMs(now: Date): Promise<number>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface TransactionRunner {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export type FaultPoint = "after-commit-before-ack" | "after-publish-before-commit";

export interface FaultInjector {
  hit(point: FaultPoint): void;
}

// ponto de extensão para autenticar o provedor (hoje não valida nada)
export interface ProviderIdentityPort {
  assertProvider(providerId: string, credentials: unknown): Promise<void>;
}

export type MetricName =
  | "transactions_total"
  | "duplicates_total"
  | "retries_total"
  | "dlq_messages_total"
  | "lock_conflicts_total"
  | "reconciliation_mismatches_total";

export interface Metrics {
  inc(name: MetricName, labels?: Record<string, string>): void;
  observe(name: "processing_latency_seconds", value: number, labels?: Record<string, string>): void;
  setOutboxLag(ms: number): void;
}
