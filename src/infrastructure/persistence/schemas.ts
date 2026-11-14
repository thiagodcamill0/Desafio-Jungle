import { EntitySchema } from "@mikro-orm/postgresql";

// Linhas das tabelas. O domínio não conhece estes tipos; os mappers fazem a ponte.

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  observedBalance: string | null;
  observedCurrency: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface LedgerEntryRow {
  id: string;
  seq?: bigint;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export interface InboxRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface OutboxRow {
  id: string;
  seq?: bigint;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

const money = { type: "decimal", precision: 19, scale: 2 } as const;
const timestamp = { type: "Date", columnType: "timestamptz" } as const;
const nullable = { nullable: true } as const;
// seq é identity: o banco gera, nunca enviamos no insert
const identitySeq = { type: "bigint", generated: "identity" } as const;

export const WalletSchema = new EntitySchema<WalletRow>({
  name: "WalletRow",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    balance: money,
    version: { type: "integer" },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: "WagerTransactionRow",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "text" },
    externalTransactionId: { type: "text" },
    idempotencyKey: { type: "text" },
    payloadHash: { type: "text" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "text" },
    gameId: { type: "text" },
    kind: { type: "text" },
    amount: money,
    currency: { type: "string", length: 3 },
    referenceExternalTransactionId: { type: "text", ...nullable },
    referenceTransactionId: { type: "uuid", ...nullable },
    status: { type: "text" },
    failureCode: { type: "text", ...nullable },
    observedBalance: { ...money, ...nullable },
    observedCurrency: { type: "string", length: 3, ...nullable },
    referenceAttempts: { type: "integer" },
    nextReferenceAttemptAt: { ...timestamp, ...nullable },
    createdAt: timestamp,
    processedAt: { ...timestamp, ...nullable },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
  name: "LedgerEntryRow",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    seq: identitySeq,
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "text" },
    amount: money,
    currency: { type: "string", length: 3 },
    balanceBefore: money,
    balanceAfter: money,
    createdAt: timestamp,
  },
});

export const InboxSchema = new EntitySchema<InboxRow>({
  name: "InboxRow",
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "text", primary: true },
    messageId: { type: "text", primary: true },
    payloadHash: { type: "text" },
    receivedAt: timestamp,
    processedAt: { ...timestamp, ...nullable },
  },
});

export const OutboxSchema = new EntitySchema<OutboxRow>({
  name: "OutboxRow",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    seq: identitySeq,
    aggregateId: { type: "uuid" },
    eventType: { type: "text" },
    payload: { type: "json" },
    occurredAt: timestamp,
    attempts: { type: "integer" },
    nextAttemptAt: timestamp,
    publishedAt: { ...timestamp, ...nullable },
  },
});

export const persistenceSchemas = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxSchema, OutboxSchema];
