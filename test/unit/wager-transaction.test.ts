import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import {
  MAX_REFERENCE_ATTEMPTS,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from "../../src/domain/wager-transaction";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { DomainError, InvalidMoneyError, InvalidTransactionStateError } from "../../src/domain/errors";
import { FailureCode } from "../../src/domain/failure-code";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-11-13T10:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

let seq = 0;
function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  seq += 1;
  return {
    id: `tx-${seq}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: "hash-1",
    walletId: "w1",
    playerId: "p1",
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: brl("10.00"),
    createdAt: T0,
    ...overrides,
  };
}

const create = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(overrides));

function expectDomainError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code as DomainError["code"]);
    return;
  }
  throw new Error(`esperava DomainError ${code}`);
}

describe("WagerTransaction.create", () => {
  test("BET nasce PENDING, sem decisão", () => {
    const tx = create();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.observedBalance).toBeUndefined();
  });

  test("OPENING não pode ser submetido de fora", () => {
    expectDomainError(() => create({ kind: Kind.Opening }), FailureCode.KIND_NOT_ALLOWED);
  });

  test("REFUND e ROLLBACK exigem referência", () => {
    expectDomainError(() => create({ kind: Kind.Refund }), FailureCode.INVALID_PAYLOAD);
    expectDomainError(() => create({ kind: Kind.Rollback, referenceExternalTransactionId: "" }), FailureCode.INVALID_PAYLOAD);
  });

  test("BET e LOSS não aceitam referência", () => {
    expectDomainError(() => create({ kind: Kind.Bet, referenceExternalTransactionId: "x" }), FailureCode.INVALID_PAYLOAD);
    expectDomainError(() => create({ kind: Kind.Loss, referenceExternalTransactionId: "x" }), FailureCode.INVALID_PAYLOAD);
  });

  test("WIN aceita referência opcional", () => {
    expect(create({ kind: Kind.Win }).referenceExternalTransactionId).toBeUndefined();
    expect(create({ kind: Kind.Win, referenceExternalTransactionId: "bet-1" }).referenceExternalTransactionId).toBe("bet-1");
  });

  test("BET de 0.00 é rejeitada; LOSS de 0.00 é aceita", () => {
    expect(() => create({ money: brl("0.00") })).toThrow(InvalidMoneyError);
    expect(create({ kind: Kind.Loss, money: brl("0.00") }).status).toBe(Status.Pending);
  });

  test("createOpening monta a transação interna de abertura", () => {
    const tx = WagerTransaction.createOpening({ id: "o1", walletId: "w9", playerId: "p9", money: brl("100.00"), at: T0 });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe("internal");
    expect(tx.externalTransactionId).toBe("w9");
    expect(tx.idempotencyKey).toBe("opening:w9");
    expect(tx.roundId).toBe("opening");
    expect(tx.gameId).toBe("opening");
    expect(tx.status).toBe(Status.Pending);
  });
});

describe("transições", () => {
  test("PENDING → PROCESSED guarda referência, saldo observado e data", () => {
    const tx = create();
    tx.markProcessed("ref-id", brl("90.00"), plus(5));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe("ref-id");
    expect(tx.observedBalance?.amount).toBe("90.00");
    expect(tx.processedAt).toEqual(plus(5));
    expect(tx.isTerminal()).toBe(true);
  });

  test("PENDING → REJECTED guarda failureCode e saldo observado", () => {
    const tx = create();
    tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl("5.00"), plus(1));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(tx.observedBalance?.amount).toBe("5.00");
  });

  test("PENDING → FAILED guarda failureCode", () => {
    const tx = create();
    tx.fail(FailureCode.PROCESSING_FAILED, plus(1));
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.PROCESSING_FAILED);
  });

  test("estados terminais não mudam mais", () => {
    const processed = create();
    processed.markProcessed(undefined, brl("1.00"), T0);
    expect(() => processed.reject(FailureCode.INSUFFICIENT_FUNDS, brl("1.00"), T0)).toThrow(InvalidTransactionStateError);

    const rejected = create();
    rejected.reject(FailureCode.INSUFFICIENT_FUNDS, brl("1.00"), T0);
    expect(() => rejected.markProcessed(undefined, brl("1.00"), T0)).toThrow(InvalidTransactionStateError);

    const failed = create();
    failed.fail(FailureCode.PROCESSING_FAILED, T0);
    expect(() => failed.markPendingReference(brl("1.00"), T0)).toThrow(InvalidTransactionStateError);
    expect(() => failed.fail(FailureCode.PROCESSING_FAILED, T0)).toThrow(InvalidTransactionStateError);
  });

  test("PENDING → PENDING_REFERENCE agenda a primeira tentativa em 1s", () => {
    const tx = create({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(brl("50.00"), T0);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt).toEqual(plus(1_000));
    expect(tx.observedBalance?.amount).toBe("50.00");
  });

  test("PENDING_REFERENCE → PROCESSED e → REJECTED são permitidos", () => {
    const a = create({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    a.markPendingReference(brl("1.00"), T0);
    a.markProcessed("bet-id", brl("11.00"), plus(2_000));
    expect(a.status).toBe(Status.Processed);
    expect(a.nextReferenceAttemptAt).toBeUndefined();

    const b = create({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    b.markPendingReference(brl("1.00"), T0);
    b.reject(FailureCode.REFERENCE_NOT_FOUND, brl("1.00"), plus(2_000));
    expect(b.status).toBe(Status.Rejected);
  });

  test("markPendingReference duas vezes é erro (retry usa scheduleReferenceRetry)", () => {
    const tx = create({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(brl("1.00"), T0);
    expect(() => tx.markPendingReference(brl("1.00"), T0)).toThrow(InvalidTransactionStateError);
  });

  test("scheduleReferenceRetry: backoff exponencial com teto de 60s", () => {
    const tx = create({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(brl("1.00"), T0);
    tx.scheduleReferenceRetry(T0);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt).toEqual(plus(2_000));
    for (let i = 0; i < 5; i++) tx.scheduleReferenceRetry(T0);
    expect(tx.referenceAttempts).toBe(6);
    expect(tx.nextReferenceAttemptAt).toEqual(plus(60_000));
  });

  test("scheduleReferenceRetry fora de PENDING_REFERENCE é erro", () => {
    expect(() => create().scheduleReferenceRetry(T0)).toThrow(InvalidTransactionStateError);
  });

  test("referenceRetriesExhausted depois de MAX_REFERENCE_ATTEMPTS tentativas", () => {
    expect(MAX_REFERENCE_ATTEMPTS).toBe(10);
    const tx = create({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(brl("1.00"), T0);
    for (let i = 0; i < MAX_REFERENCE_ATTEMPTS - 2; i++) tx.scheduleReferenceRetry(T0);
    expect(tx.referenceRetriesExhausted()).toBe(false);
    tx.scheduleReferenceRetry(T0);
    expect(tx.referenceRetriesExhausted()).toBe(true);
  });
});

describe("consultas de domínio", () => {
  test("affectsBalance é falso só para LOSS", () => {
    expect(create({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    expect(create({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(create({ kind: Kind.Win }).affectsBalance()).toBe(true);
  });

  test("requiresReference para REFUND e ROLLBACK", () => {
    expect(create({ kind: Kind.Refund, referenceExternalTransactionId: "r" }).requiresReference()).toBe(true);
    expect(create({ kind: Kind.Rollback, referenceExternalTransactionId: "r" }).requiresReference()).toBe(true);
    expect(create({ kind: Kind.Win }).requiresReference()).toBe(false);
  });

  test("matchesPayload compara o hash", () => {
    const tx = create({ payloadHash: "abc" });
    expect(tx.matchesPayload("abc")).toBe(true);
    expect(tx.matchesPayload("xyz")).toBe(false);
  });

  test("ledgerDirectionFor: BET debita, WIN/REFUND/OPENING creditam", () => {
    expect(create({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(create({ kind: Kind.Refund, referenceExternalTransactionId: "r" }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const opening = WagerTransaction.createOpening({ id: "o", walletId: "w", playerId: "p", money: brl("1.00"), at: T0 });
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("ledgerDirectionFor: ROLLBACK inverte a direção da referência", () => {
    const rollback = create({ kind: Kind.Rollback, referenceExternalTransactionId: "r" });
    expect(rollback.ledgerDirectionFor(create({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(create({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(create({ kind: Kind.Refund, referenceExternalTransactionId: "r" }))).toBe(LedgerDirection.Debit);
  });

  test("ledgerDirectionFor: LOSS e ROLLBACK sem referência são erro de programação", () => {
    expect(() => create({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => create({ kind: Kind.Rollback, referenceExternalTransactionId: "r" }).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe("rehydrate / toState", () => {
  test("ida e volta preserva o estado, inclusive terminal", () => {
    const tx = create({ kind: Kind.Win, referenceExternalTransactionId: "bet-1" });
    tx.markProcessed("bet-id", brl("20.00"), plus(3));
    const state = tx.toState();
    expect(WagerTransaction.rehydrate(state).toState()).toEqual(state);
    expect(WagerTransaction.rehydrate(state).status).toBe(Status.Processed);
  });
});
