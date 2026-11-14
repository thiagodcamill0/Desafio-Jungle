import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { ApplicationError, ConflictError, NotFoundError, TransientInfraError, ValidationError } from "../../application/errors";
import { DomainError } from "../../domain/errors";
import { FailureCode } from "../../domain/failure-code";

export interface ErrorBody {
  code: FailureCode;
  message: string;
}

const INPUT_CODES = new Set<FailureCode>([
  FailureCode.INVALID_PAYLOAD,
  FailureCode.INVALID_MONEY,
  FailureCode.MISSING_IDEMPOTENCY_KEY,
  FailureCode.KIND_NOT_ALLOWED,
]);

export const RETRY_AFTER_SECONDS = "1";

// Tabela única erro → HTTP, usada por todos os endpoints.
export function toHttpError(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof TransientInfraError) return { status: 503, body: bodyOf(error) };
  if (error instanceof ValidationError) return { status: 400, body: bodyOf(error) };
  if (error instanceof NotFoundError) return { status: 404, body: bodyOf(error) };
  if (error instanceof ConflictError) return { status: 409, body: bodyOf(error) };
  if (error instanceof DomainError || error instanceof ApplicationError) {
    return { status: INPUT_CODES.has(error.code) ? 400 : 422, body: bodyOf(error) };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === 404 ? FailureCode.ROUTE_NOT_FOUND : status < 500 ? FailureCode.INVALID_PAYLOAD : FailureCode.PROCESSING_FAILED;
    return { status, body: { code, message: error.message } };
  }
  return { status: 500, body: { code: FailureCode.PROCESSING_FAILED, message: "Internal error" } };
}

const bodyOf = (error: DomainError | ApplicationError): ErrorBody => ({ code: error.code, message: error.message });

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("HttpErrorFilter");

  catch(error: unknown, host: ArgumentsHost): void {
    const { status, body } = toHttpError(error);
    if (status >= 500 && status !== 503) this.logger.error(error instanceof Error ? error.stack : String(error));
    const res = host.switchToHttp().getResponse<HttpResponse>();
    if (status === 503) res.setHeader("Retry-After", RETRY_AFTER_SECONDS);
    res.status(status).json(body);
  }
}
