import { InsufficientFundsError } from "../domain/errors";
import { FailureCode } from "../domain/failure-code";
import { WagerTransactionKind, type WagerTransaction } from "../domain/wager-transaction";
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

// Decide a transação contra a wallet travada: processa (com ou sem lançamento) ou rejeita.
export function applyWager({ wallet, tx, reference, ids, now }: ApplyWagerParams): { entry?: WalletLedgerEntry } {
  if (tx.playerId !== wallet.playerId) {
    tx.reject(FailureCode.WALLET_PLAYER_MISMATCH, wallet.balance, now);
    return {};
  }
  if (tx.money.currency !== wallet.currency) {
    tx.reject(FailureCode.CURRENCY_MISMATCH, wallet.balance, now);
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
    if (!(error instanceof InsufficientFundsError)) throw error;
    const code = tx.kind === WagerTransactionKind.Bet ? FailureCode.INSUFFICIENT_FUNDS : FailureCode.REVERSAL_INSUFFICIENT_FUNDS;
    tx.reject(code, wallet.balance, now);
    return {};
  }
}
