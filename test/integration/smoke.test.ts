import { describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createApp } from "../../src/main";
import { loadConfig } from "../../src/infrastructure/config";

describe("smoke", () => {
  test("app sobe, conecta no Postgres e responde /health/live", async () => {
    const app = await createApp(loadConfig({ ...process.env, PORT: "0", APP_ROLES: "api" }));
    await app.listen(0);
    try {
      const res = await fetch(`${await app.getUrl()}/health/live`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
      const orm = app.get(MikroORM);
      // MikroORM 7 conecta de forma preguiçosa: só uma query real prova a conexão.
      expect(await orm.em.getConnection().execute("select 1 as ok")).toEqual([{ ok: 1 }]);
    } finally {
      await app.close();
    }
  });
});
