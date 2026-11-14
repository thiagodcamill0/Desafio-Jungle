import { FailureCode } from "../domain/failure-code";
import { NotFoundError, ValidationError } from "./errors";
import type { TransactionRunner } from "./ports";
import { toLedgerEntryView, toTransactionView, toWalletView, type LedgerEntryView, type TransactionView, type WalletView } from "./views";

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor?: string;
}

export class WalletQueries {
  constructor(private readonly runner: TransactionRunner) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.runner.run((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw walletNotFound(walletId);
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, page: { cursor?: string; limit: number }): Promise<LedgerPageView> {
    const beforeSeq = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    return this.runner.run(async (repos) => {
      if (!(await repos.wallets.findById(walletId))) throw walletNotFound(walletId);
      const result = await repos.ledger.listByWallet(walletId, { beforeSeq, limit: page.limit });
      return {
        items: result.entries.map(toLedgerEntryView),
        ...(result.lastSeq !== undefined && { nextCursor: encodeCursor(result.lastSeq) }),
      };
    });
  }
}

export class TransactionQueries {
  constructor(private readonly runner: TransactionRunner) {}

  async getById(transactionId: string): Promise<TransactionView> {
    const tx = await this.runner.run((repos) => repos.transactions.findById(transactionId));
    if (!tx) throw new NotFoundError(FailureCode.TRANSACTION_NOT_FOUND, `Transaction ${transactionId} not found`);
    return toTransactionView(tx);
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.runner.run((repos) => repos.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new NotFoundError(FailureCode.TRANSACTION_NOT_FOUND, `Transaction ${providerId}/${externalTransactionId} not found`);
    return toTransactionView(tx);
  }
}

const walletNotFound = (walletId: string) => new NotFoundError(FailureCode.WALLET_NOT_FOUND, `Wallet ${walletId} not found`);

const MAX_SEQ = 9_223_372_036_854_775_807n;

// cursor opaco: base64url do seq
export function encodeCursor(seq: bigint): string {
  return Buffer.from(JSON.stringify({ s: seq.toString() })).toString("base64url");
}

export function decodeCursor(cursor: string): bigint {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof parsed.s === "string" && /^\d{1,19}$/.test(parsed.s) && BigInt(parsed.s) <= MAX_SEQ) return BigInt(parsed.s);
  } catch {
    // cai no erro abaixo
  }
  throw new ValidationError(FailureCode.INVALID_PAYLOAD, "Invalid cursor");
}
