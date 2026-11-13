import { Module, type DynamicModule } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { HealthController } from "./infrastructure/observability/health.controller";
import { mikroOrmOptions } from "./infrastructure/persistence/mikro-orm.config";
import type { AppConfig } from "./infrastructure/config";

export const APP_CONFIG = Symbol("APP_CONFIG");

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(mikroOrmOptions(config))],
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    };
  }
}
