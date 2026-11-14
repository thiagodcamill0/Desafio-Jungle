import type { Clock, IdGenerator, Metrics, ProviderIdentityPort } from "../application/ports";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

// UUIDv7 é ordenável por tempo, o que ajuda os índices
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

// Sem autenticação por enquanto: aceita qualquer provedor. Ver ARCHITECTURE.md.
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  async assertProvider(): Promise<void> {}
}

// métricas que não fazem nada, usadas nos testes
export class NoopMetrics implements Metrics {
  inc(): void {}
  observe(): void {}
  setOutboxLag(): void {}
}
