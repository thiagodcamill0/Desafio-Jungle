import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from "@nestjs/common";
import { ValidationError } from "../../application/errors";
import { TransactionQueries } from "../../application/queries";
import { SubmitWagerTransaction, type SubmitResult } from "../../application/submit-wager-transaction";
import type { TransactionView } from "../../application/views";
import { FailureCode } from "../../domain/failure-code";
import { WagerTransactionStatus } from "../../domain/wager-transaction";
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
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submitWager: SubmitWagerTransaction,
    @Inject(TransactionQueries) private readonly queries: TransactionQueries,
  ) {}

  @Get("transactions/:transactionId")
  get(@Param("transactionId") transactionId: string): Promise<TransactionView> {
    return this.queries.getById(parseInput(uuidParam, transactionId));
  }

  @Post("transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Res() res: JsonResponse,
  ): Promise<void> {
    const idempotencyKey = idempotencyKeyHeader?.trim();
    if (!idempotencyKey) throw new ValidationError(FailureCode.MISSING_IDEMPOTENCY_KEY, "Idempotency-Key header is required");
    const input = parseInput(wagerBody, body);

    const result = (await this.submitWager.execute({ ...input, idempotencyKey }, { correlationId: correlationId ?? Bun.randomUUIDv7() })) as SubmitResult;
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
    return this.queries.getByExternalId(providerId, externalTransactionId);
  }
}
