import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { MetricName, Metrics } from "../../application/ports";

// Registry próprio (não o global): várias instâncias do app no mesmo processo de teste não colidem.
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters: Record<MetricName, Counter>;
  private readonly latency: Histogram;
  private readonly outboxLag: Gauge;

  constructor() {
    const counter = (name: string, help: string, labelNames: string[] = []) =>
      new Counter({ name, help, labelNames, registers: [this.registry] });
    this.counters = {
      transactions_total: counter("wager_transactions_total", "Wager transactions decided, by status", ["status", "kind", "source"]),
      duplicates_total: counter("duplicates_total", "Duplicates detected (idempotency replay or inbox)", ["source"]),
      retries_total: counter("retries_total", "Messages scheduled for retry", ["source"]),
      dlq_messages_total: counter("dlq_messages_total", "Messages sent to the DLQ", ["reason"]),
      lock_conflicts_total: counter("lock_conflicts_total", "Lock timeouts, slow lock waits and version conflicts", ["reason"]),
      reconciliation_mismatches_total: counter("reconciliation_mismatches_total", "Wallets whose balance did not match the ledger"),
    };
    this.latency = new Histogram({
      name: "processing_latency_seconds",
      help: "Wager processing latency",
      labelNames: ["source"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.outboxLag = new Gauge({ name: "outbox_lag_seconds", help: "Age of the oldest unpublished outbox message", registers: [this.registry] });
    collectDefaultMetrics({ register: this.registry });
  }

  inc(name: MetricName, labels: Record<string, string> = {}): void {
    this.counters[name].inc(labels);
  }

  observe(_name: "processing_latency_seconds", value: number, labels: Record<string, string> = {}): void {
    this.latency.observe(labels, value);
  }

  setOutboxLag(ms: number): void {
    this.outboxLag.set(ms / 1_000);
  }
}
