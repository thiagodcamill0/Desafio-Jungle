import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry";
import { CurrencyMismatchError, InsufficientFundsError, InvalidLedgerEntryError, InvalidMoneyError } from "../../src/domain/errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-11-13T10:00:00.000Z");
const T1 = new Date("2026-11-13T10:00:01.000Z");

const openWith = (amount: string) =>
  Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(amount), openingTransactionId: "t0", openingEntryId: "e0", at: T0 });

const move = (money: Money, n = 1) => ({ money, transactionId: `t${n}`, entryId: `e${n}`, at: T1 });

describe("Wallet.open", () => {
  test("saldo > 0 gera CREDIT de abertura e version 1", () => {
    const { wallet, openingEntry } = openWith("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe("t0");
    expect(openingEntry?.balanceBefore.amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.amount).toBe("100.00");
  });

  test("saldo 0 não gera lançamento", () => {
    const { wallet, openingEntry } = openWith("0.00");
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test("saldo inicial negativo é rejeitado", () => {
    expect(() =>
      Wallet.open({ id: "w", playerId: "p", initialBalance: brl("0.00").subtract(brl("1.00")), openingTransactionId: "t", openingEntryId: "e", at: T0 }),
    ).toThrow(InvalidMoneyError);
  });
});

describe("Wallet.debit / credit", () => {
  test("debit gera DEBIT balanceado e incrementa version", () => {
    const { wallet } = openWith("100.00");
    const entry = wallet.debit(move(brl("80.00")));
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe("w1");
    expect(entry.transactionId).toBe("t1");
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("20.00");
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
  });

  test("debit de todo o saldo deixa 0.00", () => {
    const { wallet } = openWith("10.00");
    wallet.debit(move(brl("10.00")));
    expect(wallet.balance.amount).toBe("0.00");
  });

  test("debit sem saldo lança InsufficientFundsError e não muda nada", () => {
    const { wallet } = openWith("10.00");
    expect(() => wallet.debit(move(brl("10.01")))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("10.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test("credit gera CREDIT, saldo do lançamento bate com o da wallet", () => {
    const { wallet } = openWith("10.00");
    const entry = wallet.credit(move(brl("5.50")));
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe("15.50");
    expect(wallet.version).toBe(2);
  });

  test("movimentos de valor zero são rejeitados", () => {
    const { wallet } = openWith("10.00");
    expect(() => wallet.debit(move(brl("0.00")))).toThrow(InvalidMoneyError);
    expect(() => wallet.credit(move(brl("0.00")))).toThrow(InvalidMoneyError);
    expect(wallet.version).toBe(1);
  });

  test("moeda diferente lança CurrencyMismatchError sem alterar a wallet", () => {
    const { wallet } = openWith("10.00");
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.credit(move(usd))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(move(usd))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.amount).toBe("10.00");
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet.rehydrate / toState", () => {
  test("rehydrate não revalida e toState devolve o mesmo estado", () => {
    const state = { id: "w", playerId: "p", currency: "BRL", balance: brl("5.00"), version: 7, createdAt: T0, updatedAt: T1 };
    const wallet = Wallet.rehydrate(state);
    expect(wallet.version).toBe(7);
    expect(wallet.toState()).toEqual(state);
  });
});

describe("WalletLedgerEntry", () => {
  const base = { id: "e", walletId: "w", transactionId: "t", createdAt: T0 };

  test("lançamento desbalanceado é rejeitado na factory", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl("5.00"), balanceBefore: brl("10.00"), balanceAfter: brl("14.00") }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("valor não positivo é rejeitado", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl("0.00"), balanceBefore: brl("1.00"), balanceAfter: brl("1.00") }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("saldo final negativo é rejeitado", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("5.00"),
        balanceBefore: brl("1.00"),
        balanceAfter: brl("1.00").subtract(brl("5.00")),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("lançamento válido é balanceado e imutável por estrutura", () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl("3.00"), balanceBefore: brl("10.00"), balanceAfter: brl("7.00") });
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  test("rehydrate reconstrói sem revalidar", () => {
    const state = { ...base, direction: LedgerDirection.Credit, money: brl("1.00"), balanceBefore: brl("0.00"), balanceAfter: brl("1.00") };
    expect(WalletLedgerEntry.rehydrate(state).toState()).toEqual(state);
  });
});
