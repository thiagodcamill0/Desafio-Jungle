import { Logger, Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { OpenWallet } from "./application/open-wallet";
import { SubmitWagerTransaction } from "./application/submit-wager-transaction";
import type { Clock, EventPublisher, FaultInjector, IdGenerator, Metrics, TransactionRunner } from "./application/ports";
import { TransactionQueries, WalletQueries } from "./application/queries";
import { ReconcileWallet } from "./application/reconcile-wallet";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "./infrastructure/config";
import { EnvFaultInjector } from "./infrastructure/fault-injector";
import { OutboxPublisher } from "./infrastructure/messaging/outbox-publisher";
import { createSqsClient, SqsEventPublisher } from "./infrastructure/messaging/sqs";
import { WagerConsumer } from "./infrastructure/messaging/wager-consumer";
import { HealthController } from "./infrastructure/observability/health.controller";
import { mikroOrmOptions } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmTransactionRunner } from "./infrastructure/persistence/transaction-runner";
import { AllowAllProviderIdentity, NoopMetrics, SystemClock, UuidV7Generator } from "./infrastructure/system";
import { PendingReferenceWorker } from "./infrastructure/workers/pending-reference-worker";
import { HttpErrorFilter } from "./interface/http/error-mapping";
import { ProviderAuthGuard } from "./interface/http/provider-auth.guard";
import { ProviderTransactionsController, WageringController } from "./interface/http/wagering.controller";
import { WalletsController } from "./interface/http/wallets.controller";
import { APP_CONFIG, CLOCK, EVENT_PUBLISHER, FAULT_INJECTOR, ID_GENERATOR, METRICS, PROVIDER_IDENTITY, SQS_CLIENT, TRANSACTION_RUNNER } from "./tokens";

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
        { provide: FAULT_INJECTOR, useValue: new EnvFaultInjector(config.faultPoint) },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
        { provide: EVENT_PUBLISHER, useFactory: (client: SQSClient) => new SqsEventPublisher(client, config.eventsQueueName), inject: [SQS_CLIENT] },
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
          provide: WagerConsumer,
          useFactory: (client: SQSClient, submit: SubmitWagerTransaction, metrics: Metrics, faults: FaultInjector) =>
            new WagerConsumer(client, config, submit, metrics, faults, { enabled: config.roles.has("consumer") }),
          inject: [SQS_CLIENT, SubmitWagerTransaction, METRICS, FAULT_INJECTOR],
        },
        {
          provide: OutboxPublisher,
          useFactory: (runner: TransactionRunner, events: EventPublisher, clock: Clock, metrics: Metrics, faults: FaultInjector) =>
            new OutboxPublisher(runner, events, clock, metrics, faults, { enabled: config.roles.has("outbox") }),
          inject: [TRANSACTION_RUNNER, EVENT_PUBLISHER, CLOCK, METRICS, FAULT_INJECTOR],
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
