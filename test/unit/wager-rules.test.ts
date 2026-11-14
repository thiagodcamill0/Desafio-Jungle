import { describe, expect, test } from "bun:test";
import { applyWager, validateReference } from "../../src/application/wager-rules";
import { Money } from "../../src/domain/money";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";

const NOW = new Date("2026-11-14T10:00:00.000Z");
let seq = 0;
const ids = { next: () => `id-${++seq}` };
const money = (amount: string, currency = "BRL") => Money.from({ amount, currency });

const wallet = (amount: string) =>
  Wallet.open({ id: "w1", playerId: "p1", initialBalance: money(amount), openingTransactionId: "t0", openingEntryId: "e0", at: NOW }).wallet;

const tx = (kind: WagerTransactionKind, amount: string, overrides: { currency?: string; playerId?: string } = {}) =>
  WagerTransaction.create({
    id: `tx-${++seq}`,
    providerId: "prov",
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `prov:ext-${seq}`,
    payloadHash: "h",
    walletId: "w1",
    playerId: overrides.playerId ?? "p1",
    roundId: "r1",
    gameId: "g1",
    kind,
    money: money(amount, overrides.currency),
    createdAt: NOW,
  });

describe("applyWager", () => {
  test("BET aplica DEBIT", () => {
    const w = wallet("100.00");
    const bet = tx(WagerTransactionKind.Bet, "80.00");
    const { entry } = applyWager({ wallet: w, tx: bet, ids, now: NOW });
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(entry?.transactionId).toBe(bet.id);
    expect(w.balance.amount).toBe("20.00");
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.observedBalance?.amount).toBe("20.00");
  });

  test("BET sem saldo → REJECTED INSUFFICIENT_FUNDS, sem entry, wallet intacta", () => {
    const w = wallet("50.00");
    const bet = tx(WagerTransactionKind.Bet, "80.00");
    const { entry } = applyWager({ wallet: w, tx: bet, ids, now: NOW });
    expect(entry).toBeUndefined();
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
    expect(bet.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(bet.observedBalance?.amount).toBe("50.00");
    expect(w.balance.amount).toBe("50.00");
    expect(w.version).toBe(1);
  });

  test("WIN → CREDIT", () => {
    const w = wallet("10.00");
    const win = tx(WagerTransactionKind.Win, "15.00");
    const { entry } = applyWager({ wallet: w, tx: win, ids, now: NOW });
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe("25.00");
    expect(win.status).toBe(WagerTransactionStatus.Processed);
  });

  test("LOSS → PROCESSED sem entry e sem mudar version", () => {
    const w = wallet("10.00");
    const loss = tx(WagerTransactionKind.Loss, "0.00");
    const { entry } = applyWager({ wallet: w, tx: loss, ids, now: NOW });
    expect(entry).toBeUndefined();
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.observedBalance?.amount).toBe("10.00");
    expect(w.version).toBe(1);
  });

  test("moeda diferente → REJECTED CURRENCY_MISMATCH", () => {
    const w = wallet("100.00");
    const bet = tx(WagerTransactionKind.Bet, "10.00", { currency: "USD" });
    const { entry } = applyWager({ wallet: w, tx: bet, ids, now: NOW });
    expect(entry).toBeUndefined();
    expect(bet.failureCode).toBe("CURRENCY_MISMATCH");
    expect(w.balance.amount).toBe("100.00");
  });

  test("LOSS em moeda diferente também é rejeitado", () => {
    const loss = tx(WagerTransactionKind.Loss, "0.00", { currency: "USD" });
    applyWager({ wallet: wallet("1.00"), tx: loss, ids, now: NOW });
    expect(loss.failureCode).toBe("CURRENCY_MISMATCH");
  });

  test("player diferente do dono da wallet → REJECTED WALLET_PLAYER_MISMATCH", () => {
    const w = wallet("100.00");
    const bet = tx(WagerTransactionKind.Bet, "10.00", { playerId: "intruder" });
    applyWager({ wallet: w, tx: bet, ids, now: NOW });
    expect(bet.failureCode).toBe("WALLET_PLAYER_MISMATCH");
    expect(w.balance.amount).toBe("100.00");
  });

  test("ROLLBACK de WIN sem saldo → REVERSAL_INSUFFICIENT_FUNDS", () => {
    const w = wallet("5.00");
    const win = tx(WagerTransactionKind.Win, "20.00");
    win.markProcessed(undefined, money("25.00"), NOW);
    const rollback = WagerTransaction.create({ ...tx(WagerTransactionKind.Win, "20.00").toState(), kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: win.externalTransactionId });
    const { entry } = applyWager({ wallet: w, tx: rollback, reference: win, ids, now: NOW });
    expect(entry).toBeUndefined();
    expect(rollback.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    expect(w.balance.amount).toBe("5.00");
  });
});

describe("validateReference", () => {
  const ref = (kind: WagerTransactionKind, amount = "10.00", overrides: Partial<{ roundId: string; playerId: string; currency: string }> = {}) => {
    const r = WagerTransaction.create({
      ...tx(WagerTransactionKind.Win, amount, { currency: overrides.currency, playerId: overrides.playerId }).toState(),
      roundId: overrides.roundId ?? "r1",
      kind,
      referenceExternalTransactionId: kind === WagerTransactionKind.Rollback || kind === WagerTransactionKind.Refund ? "x" : undefined,
    });
    r.markProcessed(undefined, money("0.00", overrides.currency), NOW);
    return r;
  };
  const reversal = (kind: WagerTransactionKind, amount = "10.00") =>
    WagerTransaction.create({ ...tx(WagerTransactionKind.Win, amount).toState(), kind, referenceExternalTransactionId: "ref" });

  test("REFUND de BET processada, mesmo valor → válido", () => {
    expect(validateReference(reversal(WagerTransactionKind.Refund), ref(WagerTransactionKind.Bet), false)).toBeNull();
  });

  test("rodada diferente → REFERENCE_MISMATCH", () => {
    expect(validateReference(reversal(WagerTransactionKind.Refund), ref(WagerTransactionKind.Bet, "10.00", { roundId: "r2" }), false)).toBe("REFERENCE_MISMATCH");
  });

  test("player diferente → REFERENCE_MISMATCH", () => {
    expect(validateReference(reversal(WagerTransactionKind.Refund), ref(WagerTransactionKind.Bet, "10.00", { playerId: "p2" }), false)).toBe("REFERENCE_MISMATCH");
  });

  test("moeda diferente → REFERENCE_MISMATCH", () => {
    expect(validateReference(reversal(WagerTransactionKind.Refund), ref(WagerTransactionKind.Bet, "10.00", { currency: "USD" }), false)).toBe("REFERENCE_MISMATCH");
  });

  test("REFUND de WIN → REFERENCE_KIND_NOT_ALLOWED", () => {
    expect(validateReference(reversal(WagerTransactionKind.Refund), ref(WagerTransactionKind.Win), false)).toBe("REFERENCE_KIND_NOT_ALLOWED");
  });

  test("ROLLBACK de LOSS ou de ROLLBACK → REFERENCE_KIND_NOT_ALLOWED", () => {
    expect(validateReference(reversal(WagerTransactionKind.Rollback), ref(WagerTransactionKind.Loss), false)).toBe("REFERENCE_KIND_NOT_ALLOWED");
    expect(validateReference(reversal(WagerTransactionKind.Rollback), ref(WagerTransactionKind.Rollback), false)).toBe("REFERENCE_KIND_NOT_ALLOWED");
  });

  test("ROLLBACK de BET, WIN ou REFUND → válido", () => {
    for (const kind of [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]) {
      expect(validateReference(reversal(WagerTransactionKind.Rollback), ref(kind), false)).toBeNull();
    }
  });

  test("WIN com referência a algo que não é BET → REFERENCE_KIND_NOT_ALLOWED", () => {
    const win = WagerTransaction.create({ ...tx(WagerTransactionKind.Win, "50.00").toState(), referenceExternalTransactionId: "ref" });
    expect(validateReference(win, ref(WagerTransactionKind.Win), false)).toBe("REFERENCE_KIND_NOT_ALLOWED");
  });

  test("WIN não compara valor com a BET", () => {
    const win = WagerTransaction.create({ ...tx(WagerTransactionKind.Win, "50.00").toState(), referenceExternalTransactionId: "ref" });
    expect(validateReference(win, ref(WagerTransactionKind.Bet, "10.00"), false)).toBeNull();
  });

  test("referência não processada → REFERENCE_NOT_PROCESSED", () => {
    const rejected = tx(WagerTransactionKind.Bet, "10.00");
    rejected.reject("INSUFFICIENT_FUNDS", money("0.00"), NOW);
    expect(validateReference(reversal(WagerTransactionKind.Refund), rejected, false)).toBe("REFERENCE_NOT_PROCESSED");
  });

  test("valor diferente → REFERENCE_AMOUNT_MISMATCH", () => {
    expect(validateReference(reversal(WagerTransactionKind.Refund, "9.99"), ref(WagerTransactionKind.Bet, "10.00"), false)).toBe("REFERENCE_AMOUNT_MISMATCH");
  });

  test("referência já revertida → REFERENCE_ALREADY_REVERSED", () => {
    expect(validateReference(reversal(WagerTransactionKind.Rollback), ref(WagerTransactionKind.Bet), true)).toBe("REFERENCE_ALREADY_REVERSED");
  });
});

describe("limite de saldo nas regras", () => {
  test("WIN que estouraria o limite → REJECTED BALANCE_LIMIT_EXCEEDED, sem lançamento", () => {
    const w = wallet("99999999999999999.00");
    const win = tx(WagerTransactionKind.Win, "5.00");
    const { entry } = applyWager({ wallet: w, tx: win, ids, now: NOW });
    expect(entry).toBeUndefined();
    expect(win.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
    expect(w.balance.amount).toBe("99999999999999999.00");
  });
});
