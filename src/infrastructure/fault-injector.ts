import type { FaultInjector, FaultPoint } from "../application/ports";

// Só para testes de crash: com FAULT_POINT definido, mata o processo naquele ponto exato.
export class EnvFaultInjector implements FaultInjector {
  constructor(private readonly faultPoint?: string) {}

  hit(point: FaultPoint): void {
    if (this.faultPoint === point) process.exit(137);
  }
}
