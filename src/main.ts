import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "./app.module";
import { loadConfig, type AppConfig } from "./infrastructure/config";

export async function createApp(config: AppConfig): Promise<INestApplication> {
  return NestFactory.create(AppModule.register(config), { logger: ["error", "warn"] });
}

if (import.meta.main) {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);

  // encerramento gracioso: app.close() roda os hooks (consumer termina o que está em andamento) e sai com 0
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}
