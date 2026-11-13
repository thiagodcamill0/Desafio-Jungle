import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "./app.module";
import { loadConfig, type AppConfig } from "./infrastructure/config";

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), { logger: ["error", "warn"] });
  app.enableShutdownHooks();
  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
}
