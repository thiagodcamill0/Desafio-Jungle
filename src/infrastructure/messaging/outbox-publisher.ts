import { Logger } from "@nestjs/common";
import type { Clock, EventPublisher, FaultInjector, Metrics, TransactionRunner } from "../../application/ports";
import { IntervalWorker } from "../workers/interval-worker";

export interface OutboxPublisherOptions {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

const DEFAULTS: OutboxPublisherOptions = { enabled: false, intervalMs: 500, batchSize: 50 };

// Publica o que já foi commitado. Se cair antes do commit, outra instância republica com o mesmo id.
export class OutboxPublisher extends IntervalWorker {
  private readonly logger = new Logger("OutboxPublisher");
  private readonly batchSize: number;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly faults: FaultInjector,
    options: Partial<OutboxPublisherOptions> = {},
  ) {
    const { enabled, intervalMs, batchSize } = { ...DEFAULTS, ...options };
    super(enabled, intervalMs);
    this.batchSize = batchSize;
  }

  // devolve quantas mensagens foram publicadas nesta rodada
  tick(): Promise<number> {
    return this.runOnce(0);
  }

  protected async work(): Promise<number> {
    return this.runner.run(async (repos) => {
      const due = await repos.outbox.claimDue(this.clock.now(), this.batchSize);
      let published = 0;
      for (const message of due) {
        try {
          await this.events.publish(message);
        } catch (error) {
          // SQS fora: adia esta e deixa o resto para a próxima rodada
          message.scheduleRetry(this.clock.now());
          await repos.outbox.save(message);
          this.logger.warn(`publish failed for ${message.id} (attempt ${message.attempts}): ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        message.markPublished(this.clock.now());
        await repos.outbox.save(message);
        published += 1;
        if (published === 1) this.faults.hit("after-publish-before-commit");
      }
      this.metrics.setOutboxLag(await repos.outbox.oldestPendingAgeMs(this.clock.now()));
      return published;
    });
  }
}
