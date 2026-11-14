import { DomainError, InvalidMoneyError, InvalidTransactionStateError } from "./errors";
import { FailureCode } from "./failure-code";
import type { Money } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING", // interno: crédito de abertura da wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // aceita, ainda não aplicada (só existe dentro da transação SQL)
  PendingReference = "PENDING_REFERENCE", // aguardando a transação referenciada
  Processed = "PROCESSED", // aplicada (terminal)
  Rejected = "REJECTED", // violação de regra de negócio (terminal)
  Failed = "FAILED", // erro permanente de infraestrutura (terminal, auditável)
}

// ~5 min de espera pela referência
export const MAX_REFERENCE_ATTEMPTS = 10;
const FIRST_REFERENCE_ATTEMPT_DELAY_MS = 1_000;
const MAX_REFERENCE_RETRY_DELAY_MS = 60_000;

const TERMINAL = new Set([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]);
const KINDS_ACCEPTING_REFERENCE = new Set([WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  // id do lado do provedor
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  // saldo no momento da decisão, devolvido no replay
  observedBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

// PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE; PENDING_REFERENCE → PROCESSED | REJECTED | FAILED.
// Os três finais não mudam mais.
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _observedBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError(FailureCode.KIND_NOT_ALLOWED, "OPENING is internal and cannot be submitted");
    }
    WagerTransaction.assertReference(props.kind, props.referenceExternalTransactionId);
    WagerTransaction.assertAmount(props.kind, props.money);
    return WagerTransaction.fromProps(props);
  }

  // crédito de abertura da wallet (interno)
  static createOpening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    WagerTransaction.assertAmount(WagerTransactionKind.Opening, props.money);
    return WagerTransaction.fromProps({
      id: props.id,
      providerId: "internal",
      externalTransactionId: props.walletId,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash: "",
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: "opening",
      gameId: "opening",
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
    });
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.observedBalance,
      s.referenceAttempts,
      s.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this.decide(observedBalance, at);
  }

  markPendingReference(observedBalance: Money, now: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference: transaction ${this.id} is ${this._status}, expected PENDING`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = observedBalance;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = new Date(now.getTime() + FIRST_REFERENCE_ATTEMPT_DELAY_MS);
  }

  // referência ainda não chegou: agenda a próxima tentativa
  scheduleReferenceRetry(now: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`scheduleReferenceRetry: transaction ${this.id} is ${this._status}`);
    }
    this._referenceAttempts += 1;
    const delay = Math.min(2 ** this._referenceAttempts * 1_000, MAX_REFERENCE_RETRY_DELAY_MS);
    this._nextReferenceAttemptAt = new Date(now.getTime() + delay);
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this.decide(observedBalance, at);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  // esta é a última tentativa permitida
  referenceRetriesExhausted(): boolean {
    return this._referenceAttempts + 1 >= MAX_REFERENCE_ATTEMPTS;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionStateError("ROLLBACK direction requires the referenced transaction");
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError("LOSS does not move balance");
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      observedBalance: this._observedBalance,
      referenceAttempts: this._referenceAttempts,
      nextReferenceAttemptAt: this._nextReferenceAttemptAt,
    };
  }

  private decide(observedBalance: Money, at: Date): void {
    this._observedBalance = observedBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${transition}: transaction ${this.id} is already ${this._status}`);
    }
  }

  private static fromProps(p: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      p.referenceExternalTransactionId,
      p.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  private static assertReference(kind: WagerTransactionKind, reference: string | undefined): void {
    const hasReference = reference !== undefined;
    if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
      throw new DomainError(FailureCode.INVALID_PAYLOAD, `${kind} requires referenceExternalTransactionId`);
    }
    if (hasReference && !KINDS_ACCEPTING_REFERENCE.has(kind)) {
      throw new DomainError(FailureCode.INVALID_PAYLOAD, `${kind} does not accept referenceExternalTransactionId`);
    }
  }

  // LOSS aceita 0.00; o resto precisa ser positivo
  private static assertAmount(kind: WagerTransactionKind, money: Money): void {
    const valid = kind === WagerTransactionKind.Loss ? !money.isNegative() : money.isPositive();
    if (!valid) throw new InvalidMoneyError(`${kind} amount must be ${kind === WagerTransactionKind.Loss ? "non-negative" : "positive"}`);
  }
}
