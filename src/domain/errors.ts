import { FailureCode } from "./failure-code";

/** Violação de regra de domínio. Carrega um código estável para o provedor decidir o que fazer. */
export class DomainError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(FailureCode.INVALID_MONEY, message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(FailureCode.CURRENCY_MISMATCH, `Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(message = "Insufficient funds") {
    super(FailureCode.INSUFFICIENT_FUNDS, message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super(FailureCode.INVALID_PAYLOAD, message);
  }
}

/** Erro de programação (ex.: transicionar um estado terminal) — não é caminho de negócio. */
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransactionStateError";
  }
}
