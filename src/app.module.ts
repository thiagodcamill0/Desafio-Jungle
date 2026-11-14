import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { OpenWallet } from "./application/open-wallet";
import type { Clock, IdGenerator, TransactionRunner } from "./application/ports";
import { WalletQueries } from "./application/queries";
import type { AppConfig } from "./infrastructure/config";
import { HealthController } from "./infrastructure/observability/health.controller";
import { mikroOrmOptions } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmTransactionRunner } from "./infrastructure/persistence/transaction-runner";
import { AllowAllProviderIdentity, SystemClock, UuidV7Generator } from "./infrastructure/system";
import { HttpErrorFilter } from "./interface/http/error-mapping";
import { ProviderAuthGuard } from "./interface/http/provider-auth.guard";
import { WalletsController } from "./interface/http/wallets.controller";
import { APP_CONFIG, CLOCK, ID_GENERATOR, PROVIDER_IDENTITY, TRANSACTION_RUNNER } from "./tokens";

export { APP_CONFIG } from "./tokens";

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(mikroOrmOptions(config))],
      controllers: [HealthController, WalletsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        { provide: PROVIDER_IDENTITY, useClass: AllowAllProviderIdentity },
        { provide: TRANSACTION_RUNNER, useFactory: (orm: MikroORM) => new MikroOrmTransactionRunner(orm), inject: [MikroORM] },
        {
          provide: OpenWallet,
          useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator) => new OpenWallet(runner, clock, ids),
          inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR],
        },
        { provide: WalletQueries, useFactory: (runner: TransactionRunner) => new WalletQueries(runner), inject: [TRANSACTION_RUNNER] },
        ProviderAuthGuard,
      ],
    };
  }
}
