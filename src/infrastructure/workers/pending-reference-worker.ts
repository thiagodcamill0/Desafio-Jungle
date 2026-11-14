import { Logger } from "@nestjs/common";
import type { Clock, TransactionRunner } from "../../application/ports";
import type { SubmitWagerTransaction } from "../../application/submit-wager-transaction";

export interface PendingReferenceWorkerOptions {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

const DEFAULTS: PendingReferenceWorkerOptions = { enabled: false, intervalMs: 1_000, batchSize: 20 };

// De tempos em tempos pega transações PENDING_REFERENCE vencidas e tenta resolvê-las.
// O claim usa SKIP LOCKED, então várias instâncias dividem o trabalho sem lock global.
export class PendingReferenceWorker {
  private readonly logger = new Logger("PendingReferenceWorker");
  private readonly options: PendingReferenceWorkerOptions;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly submitWager: SubmitWagerTransaction,
    private readonly clock: Clock,
    options: Partial<PendingReferenceWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  // uma rodada por vez; se a anterior ainda não acabou, pula
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = this.processDue().finally(() => (this.running = undefined));
    await this.running;
  }

  private async processDue(): Promise<void> {
    const ids = await this.runner.run((repos) => repos.transactions.claimDuePendingReferenceIds(this.clock.now(), this.options.batchSize));
    for (const id of ids) {
      try {
        await this.submitWager.resolvePending(id, id);
      } catch (error) {
        this.logger.warn(`resolvePending failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
