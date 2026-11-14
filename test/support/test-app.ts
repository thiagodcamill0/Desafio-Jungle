import type { INestApplication } from "@nestjs/common";
import { createApp } from "../../src/main";
import { loadConfig } from "../../src/infrastructure/config";
import { createTestDatabase, type Exec } from "./test-db";

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  databaseUrl: string;
  sql: Exec;
  close(): Promise<void>;
}

// sobe a aplicação real numa porta livre, apontando para um banco descartável
export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const db = await createTestDatabase();
  const config = loadConfig({ ...process.env, DATABASE_URL: db.url, PORT: "0", APP_ROLES: "api", ...overrides });
  const app = await createApp(config);
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace("[::1]", "localhost");
  return {
    app,
    baseUrl,
    databaseUrl: db.url,
    sql: db.sql,
    close: async () => {
      await app.close();
      await db.drop();
    },
  };
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

export async function getJson(url: string) {
  const res = await fetch(url);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}
