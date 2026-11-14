import { describe, expect, test } from "bun:test";
import { IntervalWorker } from "../../src/infrastructure/workers/interval-worker";

class FailingWorker extends IntervalWorker {
  constructor(onError: (error: unknown) => void) {
    super(true, 10, onError);
  }
  tick() {
    return this.runOnce(undefined);
  }
  protected async work(): Promise<void> {
    throw new Error("database is down");
  }
}

describe("IntervalWorker", () => {
  test("erro numa rodada é reportado, não engolido", async () => {
    const errors: unknown[] = [];
    const worker = new FailingWorker((error) => errors.push(error));
    worker.onApplicationBootstrap();
    await Bun.sleep(60);
    await worker.onModuleDestroy();
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toBe("database is down");
  });
});
