import { FailureCode } from "../domain/failure-code";

export class ApplicationError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

// banco fora do ar ou lock demorado demais: vale tentar de novo
export class TransientInfraError extends ApplicationError {
  constructor(
    code: typeof FailureCode.DATABASE_UNAVAILABLE | typeof FailureCode.LOCK_TIMEOUT,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(code, message);
  }
}

export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string,
    override readonly cause?: unknown,
  ) {
    super(`Unique constraint violated: ${constraint}`);
    this.name = "UniqueViolationError";
  }
}

// a wallet mudou entre a leitura e a escrita
export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}

// mesmo messageId chegou com conteúdo diferente
export class InboxPayloadMismatchError extends Error {
  constructor(
    readonly messageId: string,
    readonly consumerName: string,
  ) {
    super(`Inbox message ${consumerName}/${messageId} redelivered with a different payload`);
    this.name = "InboxPayloadMismatchError";
  }
}

export class ValidationError extends ApplicationError {}

export class NotFoundError extends ApplicationError {
  constructor(code: FailureCode, message = "Resource not found") {
    super(code, message);
  }
}

export class ConflictError extends ApplicationError {
  constructor(code: FailureCode, message = "Conflict") {
    super(code, message);
  }
}
