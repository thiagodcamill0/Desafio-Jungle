import { BalanceLimitExceededError, InsufficientFundsError } from "../domain/errors";
import { FailureCode } from "../domain/failure-code";
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import type { IdGenerator } from "./ports";

export interface ApplyWagerParams {
  wallet: Wallet;
  tx: WagerTransaction;
  reference?: WagerTransaction;
  ids: IdGenerator;
  now: Date;
}

// A transação precisa ser do dono da wallet e na mesma moeda.
export function walletMismatch(wallet: Wallet, tx: WagerTransaction): FailureCode | null {
  if (tx.playerId !== wallet.playerId) return FailureCode.WALLET_PLAYER_MISMATCH;
  if (tx.money.currency !== wallet.currency) return FailureCode.CURRENCY_MISMATCH;
  return null;
}

// Decide a transação contra a wallet travada: processa (com ou sem lançamento) ou rejeita.
export function applyWager({ wallet, tx, reference, ids, now }: ApplyWagerParams): { entry?: WalletLedgerEntry } {
  const mismatch = walletMismatch(wallet, tx);
  if (mismatch) {
    tx.reject(mismatch, wallet.balance, now);
    return {};
  }
  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, wallet.balance, now);
    return {};
  }

  const movement = { money: tx.money, transactionId: tx.id, entryId: ids.next(), at: now };
  try {
    const entry = tx.ledgerDirectionFor(reference) === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed(reference?.id, wallet.balance, now);
    return { entry };
  } catch (error) {
    if (error instanceof BalanceLimitExceededError) {
      tx.reject(FailureCode.BALANCE_LIMIT_EXCEEDED, wallet.balance, now);
      return {};
    }
    if (!(error instanceof InsufficientFundsError)) throw error;
    const code = tx.kind === WagerTransactionKind.Bet ? FailureCode.INSUFFICIENT_FUNDS : FailureCode.REVERSAL_INSUFFICIENT_FUNDS;
    tx.reject(code, wallet.balance, now);
    return {};
  }
}

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]),
};

// Confere se a transação pode usar essa referência. Devolve o código da primeira regra violada.
export function validateReference(tx: WagerTransaction, ref: WagerTransaction, alreadyReversed: boolean): FailureCode | null {
  const sameContext =
    ref.providerId === tx.providerId &&
    ref.playerId === tx.playerId &&
    ref.walletId === tx.walletId &&
    ref.money.currency === tx.money.currency &&
    ref.roundId === tx.roundId;
  if (!sameContext) return FailureCode.REFERENCE_MISMATCH;
  if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.has(ref.kind)) return FailureCode.REFERENCE_KIND_NOT_ALLOWED;
  if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.REFERENCE_NOT_PROCESSED;
  if (!tx.requiresReference()) return null;
  // reversão é sempre total e só pode acontecer uma vez por referência
  if (!tx.money.equals(ref.money)) return FailureCode.REFERENCE_AMOUNT_MISMATCH;
  if (alreadyReversed) return FailureCode.REFERENCE_ALREADY_REVERSED;
  return null;
}
