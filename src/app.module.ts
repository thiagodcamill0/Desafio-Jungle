import { Logger, Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { OpenWallet } from "./application/open-wallet";
import { SubmitWagerTransaction } from "./application/submit-wager-transaction";
import type { Clock, IdGenerator, Metrics, TransactionRunner } from "./application/ports";
import { TransactionQueries, WalletQueries } from "./application/queries";
import { ReconcileWallet } from "./application/reconcile-wallet";
import type { AppConfig } from "./infrastructure/config";
import { HealthController } from "./infrastructure/observability/health.controller";
import { mikroOrmOptions } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmTransactionRunner } from "./infrastructure/persistence/transaction-runner";
import { AllowAllProviderIdentity, NoopMetrics, SystemClock, UuidV7Generator } from "./infrastructure/system";
import { PendingReferenceWorker } from "./infrastructure/workers/pending-reference-worker";
import { HttpErrorFilter } from "./interface/http/error-mapping";
import { ProviderAuthGuard } from "./interface/http/provider-auth.guard";
import { ProviderTransactionsController, WageringController } from "./interface/http/wagering.controller";
import { WalletsController } from "./interface/http/wallets.controller";
import { APP_CONFIG, CLOCK, ID_GENERATOR, METRICS, PROVIDER_IDENTITY, TRANSACTION_RUNNER } from "./tokens";

export { APP_CONFIG } from "./tokens";

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(mikroOrmOptions(config))],
      controllers: [HealthController, WalletsController, WageringController, ProviderTransactionsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        { provide: PROVIDER_IDENTITY, useClass: AllowAllProviderIdentity },
        { provide: METRICS, useClass: NoopMetrics },
        { provide: TRANSACTION_RUNNER, useFactory: (orm: MikroORM) => new MikroOrmTransactionRunner(orm), inject: [MikroORM] },
        {
          provide: OpenWallet,
          useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator) => new OpenWallet(runner, clock, ids),
          inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR],
        },
        {
          provide: SubmitWagerTransaction,
          useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator) => new SubmitWagerTransaction(runner, clock, ids),
          inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR],
        },
        {
          provide: PendingReferenceWorker,
          useFactory: (runner: TransactionRunner, submit: SubmitWagerTransaction, clock: Clock) =>
            new PendingReferenceWorker(runner, submit, clock, { enabled: config.roles.has("pending") }),
          inject: [TRANSACTION_RUNNER, SubmitWagerTransaction, CLOCK],
        },
        { provide: WalletQueries, useFactory: (runner: TransactionRunner) => new WalletQueries(runner), inject: [TRANSACTION_RUNNER] },
        { provide: TransactionQueries, useFactory: (runner: TransactionRunner) => new TransactionQueries(runner), inject: [TRANSACTION_RUNNER] },
        {
          provide: ReconcileWallet,
          useFactory: (runner: TransactionRunner, metrics: Metrics) => {
            const logger = new Logger("Reconciliation");
            return new ReconcileWallet(runner, metrics, { error: (message, context) => logger.error(`${message} ${JSON.stringify(context)}`) });
          },
          inject: [TRANSACTION_RUNNER, METRICS],
        },
        ProviderAuthGuard,
      ],
    };
  }
}
