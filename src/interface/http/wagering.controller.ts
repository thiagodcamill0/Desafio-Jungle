import { Body, Controller, Get, Headers, Inject, Logger, Param, Post, Res, UseGuards } from "@nestjs/common";
import { ValidationError } from "../../application/errors";
import type { Metrics } from "../../application/ports";
import { TransactionQueries } from "../../application/queries";
import { SubmitWagerTransaction, type SubmitResult } from "../../application/submit-wager-transaction";
import type { TransactionView } from "../../application/views";
import { FailureCode } from "../../domain/failure-code";
import { WagerTransactionStatus } from "../../domain/wager-transaction";
import { addToLogContext, currentLogContext } from "../../infrastructure/observability/log-context";
import { METRICS } from "../../tokens";
import { text } from "../../application/input-schemas";
import { parseInput, uuidParam, wagerBody } from "./dto";
import { ProviderAuthGuard } from "./provider-auth.guard";

interface JsonResponse {
  status(code: number): JsonResponse;
  json(body: unknown): void;
}

const STATUS_BY_RESULT: Record<string, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
};

@Controller("wagering")
@UseGuards(ProviderAuthGuard)
export class WageringController {
  private readonly logger = new Logger("WageringController");

  constructor(
    @Inject(SubmitWagerTransaction) private readonly submitWager: SubmitWagerTransaction,
    @Inject(TransactionQueries) private readonly queries: TransactionQueries,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  @Get("transactions/:transactionId")
  get(@Param("transactionId") transactionId: string): Promise<TransactionView> {
    return this.queries.getById(parseInput(uuidParam, transactionId));
  }

  @Post("transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Res() res: JsonResponse,
  ): Promise<void> {
    const idempotencyKey = idempotencyKeyHeader?.trim();
    if (!idempotencyKey) throw new ValidationError(FailureCode.MISSING_IDEMPOTENCY_KEY, "Idempotency-Key header is required");
    parseInput(text, idempotencyKey);
    const input = parseInput(wagerBody, body);

    const correlationId = currentLogContext()?.correlationId ?? Bun.randomUUIDv7();
    const started = performance.now();
    const result = (await this.submitWager.execute({ ...input, idempotencyKey }, { correlationId })) as SubmitResult;
    this.metrics.observe("processing_latency_seconds", (performance.now() - started) / 1_000, { source: "http" });
    if (result.idempotentReplay) this.metrics.inc("duplicates_total", { source: "idempotency" });
    else this.metrics.inc("transactions_total", { status: result.status, kind: input.kind, source: "http" });
    addToLogContext({ transactionId: result.transactionId, walletId: input.walletId, providerId: input.providerId });
    this.logger.log({ msg: "wager transaction decided", kind: input.kind, status: result.status, failureCode: result.failureCode, idempotentReplay: result.idempotentReplay });

    const status = STATUS_BY_RESULT[result.status] ?? 500;
    if (status === 422) {
      res.status(status).json({ code: result.failureCode, message: `Transaction rejected: ${result.failureCode}`, ...result });
      return;
    }
    res.status(status).json(result);
  }
}

@Controller("providers")
@UseGuards(ProviderAuthGuard)
export class ProviderTransactionsController {
  constructor(@Inject(TransactionQueries) private readonly queries: TransactionQueries) {}

  @Get(":providerId/wagering/transactions/:externalTransactionId")
  get(@Param("providerId") providerId: string, @Param("externalTransactionId") externalTransactionId: string): Promise<TransactionView> {
    return this.queries.getByExternalId(parseInput(text, providerId), parseInput(text, externalTransactionId));
  }
}
