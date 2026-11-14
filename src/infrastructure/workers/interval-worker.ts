import { Logger } from "@nestjs/common";

// Base dos workers periódicos: um tick por vez e parada limpa no shutdown.
export abstract class IntervalWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<unknown>;

  protected constructor(
    private readonly enabled: boolean,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void = logError(new.target.name),
  ) {}

  protected abstract work(): Promise<unknown>;

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick().catch(this.onError), this.intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  // se a rodada anterior ainda não acabou, essa é pulada
  protected async runOnce<T>(fallback: T): Promise<T> {
    if (this.running) return fallback;
    const current = this.work().finally(() => (this.running = undefined));
    this.running = current;
    return (await current) as T;
  }

  abstract tick(): Promise<unknown>;
}

function logError(name: string): (error: unknown) => void {
  const logger = new Logger(name);
  return (error) => logger.error(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
}
