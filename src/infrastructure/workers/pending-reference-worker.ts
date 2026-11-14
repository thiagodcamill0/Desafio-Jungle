import { Logger } from "@nestjs/common";
import type { Clock, TransactionRunner } from "../../application/ports";
import type { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { IntervalWorker } from "./interval-worker";

export interface PendingReferenceWorkerOptions {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

const DEFAULTS: PendingReferenceWorkerOptions = { enabled: false, intervalMs: 1_000, batchSize: 20 };

// Tenta de novo as transações que esperam a referência. Várias instâncias dividem o trabalho.
export class PendingReferenceWorker extends IntervalWorker {
  private readonly logger = new Logger("PendingReferenceWorker");
  private readonly batchSize: number;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly submitWager: SubmitWagerTransaction,
    private readonly clock: Clock,
    options: Partial<PendingReferenceWorkerOptions> = {},
  ) {
    const { enabled, intervalMs, batchSize } = { ...DEFAULTS, ...options };
    super(enabled, intervalMs);
    this.batchSize = batchSize;
  }

  tick(): Promise<void> {
    return this.runOnce(undefined);
  }

  protected async work(): Promise<void> {
    const ids = await this.runner.run((repos) => repos.transactions.claimDuePendingReferenceIds(this.clock.now(), this.batchSize));
    for (const id of ids) {
      try {
        await this.submitWager.resolvePending(id, id);
      } catch (error) {
        this.logger.warn(`resolvePending failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
