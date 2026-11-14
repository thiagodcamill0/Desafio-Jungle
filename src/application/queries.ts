import { FailureCode } from "../domain/failure-code";
import { NotFoundError } from "./errors";
import type { TransactionRunner } from "./ports";
import { toWalletView, type WalletView } from "./views";

export class WalletQueries {
  constructor(private readonly runner: TransactionRunner) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.runner.run((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError(FailureCode.WALLET_NOT_FOUND, `Wallet ${walletId} not found`);
    return toWalletView(wallet);
  }
}
