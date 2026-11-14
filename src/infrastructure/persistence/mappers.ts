import type { FailureCode } from "../../domain/failure-code";
import { InboxMessage } from "../../domain/inbox-message";
import { Money } from "../../domain/money";
import { OutboxMessage } from "../../domain/outbox-message";
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { WalletLedgerEntry, type LedgerDirection } from "../../domain/wallet-ledger-entry";
import type { InboxRow, LedgerEntryRow, OutboxRow, WagerTransactionRow, WalletRow } from "./schemas";

// NUMERIC chega como string ("25.00"); aceita sinal para o caso de reconciliação divergente
export function moneyFromDb(amount: string, currency: string): Money {
  const normalized = normalizeScale(amount);
  if (normalized.startsWith("-")) return Money.zero(currency).subtract(Money.from({ amount: normalized.slice(1), currency }));
  return Money.from({ amount: normalized, currency });
}

function normalizeScale(amount: string): string {
  const [integer = "0", fraction = ""] = amount.split(".");
  return `${integer}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;
const orNull = <T>(value: T | undefined): T | null => value ?? null;

export const walletMapper = {
  toDomain(row: WalletRow): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: moneyFromDb(row.balance, row.currency),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },
  toRow(wallet: Wallet): WalletRow {
    const s = wallet.toState();
    return { ...s, balance: s.balance.amount };
  },
};

export const transactionMapper = {
  toDomain(row: WagerTransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money: moneyFromDb(row.amount, row.currency),
      referenceExternalTransactionId: orUndefined(row.referenceExternalTransactionId),
      createdAt: row.createdAt,
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: orUndefined(row.referenceTransactionId),
      failureCode: orUndefined(row.failureCode) as FailureCode | undefined,
      processedAt: orUndefined(row.processedAt),
      observedBalance: row.observedBalance === null ? undefined : moneyFromDb(row.observedBalance, row.observedCurrency ?? row.currency),
      referenceAttempts: row.referenceAttempts,
      nextReferenceAttemptAt: orUndefined(row.nextReferenceAttemptAt),
    });
  },
  toRow(tx: WagerTransaction): WagerTransactionRow {
    const s = tx.toState();
    return {
      id: s.id,
      providerId: s.providerId,
      externalTransactionId: s.externalTransactionId,
      idempotencyKey: s.idempotencyKey,
      payloadHash: s.payloadHash,
      walletId: s.walletId,
      playerId: s.playerId,
      roundId: s.roundId,
      gameId: s.gameId,
      kind: s.kind,
      amount: s.money.amount,
      currency: s.money.currency,
      referenceExternalTransactionId: orNull(s.referenceExternalTransactionId),
      referenceTransactionId: orNull(s.referenceTransactionId),
      status: s.status,
      failureCode: orNull(s.failureCode),
      observedBalance: s.observedBalance ? s.observedBalance.amount : null,
      observedCurrency: s.observedBalance ? s.observedBalance.currency : null,
      referenceAttempts: s.referenceAttempts,
      nextReferenceAttemptAt: orNull(s.nextReferenceAttemptAt),
      createdAt: s.createdAt,
      processedAt: orNull(s.processedAt),
    };
  },
};

export const ledgerMapper = {
  toDomain(row: LedgerEntryRow): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: row.direction as LedgerDirection,
      money: moneyFromDb(row.amount, row.currency),
      balanceBefore: moneyFromDb(row.balanceBefore, row.currency),
      balanceAfter: moneyFromDb(row.balanceAfter, row.currency),
      createdAt: row.createdAt,
    });
  },
  toRow(entry: WalletLedgerEntry): LedgerEntryRow {
    const s = entry.toState();
    return {
      id: s.id,
      walletId: s.walletId,
      transactionId: s.transactionId,
      direction: s.direction,
      amount: s.money.amount,
      currency: s.money.currency,
      balanceBefore: s.balanceBefore.amount,
      balanceAfter: s.balanceAfter.amount,
      createdAt: s.createdAt,
    };
  },
};

export const inboxMapper = {
  toDomain(row: InboxRow): InboxMessage {
    return InboxMessage.rehydrate({ ...row, processedAt: orUndefined(row.processedAt) });
  },
  toRow(message: InboxMessage): InboxRow {
    const s = message.toState();
    return { ...s, processedAt: orNull(s.processedAt) };
  },
};

export const outboxMapper = {
  toDomain(row: OutboxRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      publishedAt: orUndefined(row.publishedAt),
    });
  },
  toRow(message: OutboxMessage): OutboxRow {
    const s = message.toState();
    return {
      id: s.id,
      aggregateId: s.aggregateId,
      eventType: s.eventType,
      payload: { ...s.payload },
      occurredAt: s.occurredAt,
      attempts: s.attempts,
      nextAttemptAt: s.nextAttemptAt ?? s.occurredAt,
      publishedAt: orNull(s.publishedAt),
    };
  },
};
