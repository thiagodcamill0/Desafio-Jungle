import { FailureCode } from "../domain/failure-code";
import type { MoneyProps } from "../domain/money";
import { NotFoundError } from "./errors";
import type { Metrics, TransactionRunner } from "./ports";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export interface ReconciliationAlert {
  error(message: string, context: Record<string, unknown>): void;
}

// Compara o saldo gravado com o saldo recalculado pelo ledger. Nunca corrige: só reporta.
export class ReconcileWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly metrics: Metrics,
    private readonly alert: ReconciliationAlert,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.runner.run(async (repos) => {
      // trava a wallet para ler saldo e ledger no mesmo instante
      const wallet = await repos.wallets.lockById(walletId);
      if (!wallet) throw new NotFoundError(FailureCode.WALLET_NOT_FOUND, `Wallet ${walletId} not found`);
      const { balance: calculated, count } = await repos.ledger.computeBalance(walletId, wallet.currency);
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: count,
      };
    });

    if (!report.consistent) {
      this.metrics.inc("reconciliation_mismatches_total");
      this.alert.error("Wallet balance does not match ledger", {
        walletId,
        storedBalance: report.storedBalance.amount,
        calculatedBalance: report.calculatedBalance.amount,
        difference: report.difference.amount,
      });
    }
    return report;
  }
}
