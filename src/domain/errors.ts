import { FailureCode } from "./failure-code";

// regra de domínio violada; o code é o que o provedor usa para decidir
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

// erro de programação, não de negócio (ex.: mexer em transação já finalizada)
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransactionStateError";
  }
}

// o saldo passaria do maior valor que cabe em NUMERIC(19,2)
export class BalanceLimitExceededError extends DomainError {
  constructor(message = "Balance limit exceeded") {
    super(FailureCode.BALANCE_LIMIT_EXCEEDED, message);
  }
}
