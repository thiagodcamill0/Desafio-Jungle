import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, getJson, type TestApp } from "../support/test-app";
import { openWallet, postWager, wager } from "../support/factories";
import { createTestQueues, type TestQueues } from "../support/sqs";

let t: TestApp;
let queues: TestQueues;
const lines: string[] = [];

beforeAll(async () => {
  queues = await createTestQueues("obs");
  t = await createTestApp({ ...queues.env, LOG_LEVEL: "info" }, { logStream: { write: (line: string) => void lines.push(line) } });
});

afterAll(async () => {
  await t?.close();
});

const logs = () => lines.flatMap((line) => line.split("\n").filter(Boolean)).map((line) => JSON.parse(line));

describe("métricas", () => {
  test("/metrics contém wager_transactions_total depois de uma BET", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    await postWager(t.baseUrl, wager({ ...w, amount: "10.00" }));
    const res = await fetch(`${t.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toMatch(/wager_transactions_total\{[^}]*status="PROCESSED"[^}]*\} 1/);
    expect(body).toContain("processing_latency_seconds_bucket");
    expect(body).toContain("outbox_lag_seconds");
  });

  test("replay conta como duplicata de idempotência", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "10.00" });
    await postWager(t.baseUrl, cmd);
    await postWager(t.baseUrl, cmd);
    const body = await (await fetch(`${t.baseUrl}/metrics`)).text();
    expect(body).toMatch(/duplicates_total\{source="idempotency"\} [1-9]/);
  });
});

describe("logs e correlação", () => {
  test("resposta ecoa X-Correlation-Id (ou gera um)", async () => {
    const echoed = await fetch(`${t.baseUrl}/health/live`, { headers: { "X-Correlation-Id": "corr-123" } });
    expect(echoed.headers.get("x-correlation-id")).toBe("corr-123");
    const generated = await fetch(`${t.baseUrl}/health/live`);
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("log de uma BET é JSON com correlationId, transactionId e walletId e sem amount", async () => {
    const w = await openWallet(t.baseUrl, "100.00");
    const cmd = wager({ ...w, amount: "12.34" });
    const { idempotencyKey, ...body } = cmd;
    const res = await fetch(`${t.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey, "X-Correlation-Id": "corr-bet-1" },
      body: JSON.stringify(body),
    });
    const { transactionId } = (await res.json()) as { transactionId: string };

    const entry = logs().find((l) => l.transactionId === transactionId);
    expect(entry).toMatchObject({ correlationId: "corr-bet-1", transactionId, walletId: w.walletId, providerId: cmd.providerId, status: "PROCESSED" });
    const raw = lines.join("");
    expect(raw).not.toContain("12.34");
  });
});

describe("health", () => {
  test("/health/ready 200 com tudo de pé", async () => {
    const res = await getJson(`${t.baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { database: "up", sqs: "up" } });
  });

  test("banco fora do ar: /health/ready 503 e POST /wagering/transactions 503 com Retry-After", async () => {
    const down = await createTestApp({ ...queues.env, DATABASE_URL: "postgres://wagering:wagering@127.0.0.1:1/wagering" });
    try {
      const ready = await getJson(`${down.baseUrl}/health/ready`);
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: "down", checks: { database: "down", sqs: "up" } });
      expect((await fetch(`${down.baseUrl}/health/live`)).status).toBe(200);

      const res = await postWager(down.baseUrl, wager({ amount: "1.00" }));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(res.body.code).toBe("DATABASE_UNAVAILABLE");
    } finally {
      await down.close();
    }
  });

  test("SQS fora do ar: /health/ready 503 com sqs down", async () => {
    const down = await createTestApp({ ...queues.env, SQS_ENDPOINT: "http://127.0.0.1:1" });
    try {
      const ready = await getJson(`${down.baseUrl}/health/ready`);
      expect(ready.status).toBe(503);
      expect(ready.body.checks).toEqual({ database: "up", sqs: "down" });
    } finally {
      await down.close();
    }
  });
});
