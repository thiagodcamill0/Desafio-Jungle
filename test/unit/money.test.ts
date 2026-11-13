import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/errors";
import { FailureCode } from "../../src/domain/failure-code";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test("aceita e serializa com 2 casas", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("0.00").toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
  });

  test.each(["", "NaN", "Infinity", "1e3", "1.5", "1.505", "-1.00", " 1.00", "01.00", "1,00", "123456789012345678.00"])(
    "rejeita amount inválido %p",
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  test("aceita o maior valor que cabe em NUMERIC(19,2)", () => {
    expect(brl("99999999999999999.99").amount).toBe("99999999999999999.99");
  });

  test("rejeita moeda inválida", () => {
    for (const currency of ["brl", "BR", "BRLL", ""]) {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
    }
  });

  test("rejeita tipos que não são string (ex.: number vindo de JSON)", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("erro de dinheiro inválido carrega o código INVALID_MONEY", () => {
    try {
      brl("1.5");
      throw new Error("deveria ter lançado");
    } catch (e) {
      expect((e as InvalidMoneyError).code).toBe(FailureCode.INVALID_MONEY);
    }
  });

  test("aritmética exata (0.10 + 0.20 = 0.30)", () => {
    expect(brl("0.10").add(brl("0.20")).amount).toBe("0.30");
  });

  test("não arredonda: 3 casas é rejeitado, não ajustado", () => {
    expect(() => brl("10.005")).toThrow(InvalidMoneyError);
  });

  test("subtract pode ficar negativo e negate inverte", () => {
    const r = brl("1.00").subtract(brl("2.50"));
    expect(r.amount).toBe("-1.50");
    expect(r.isNegative()).toBe(true);
    expect(r.negate().amount).toBe("1.50");
    expect(brl("0.05").negate().amount).toBe("-0.05");
  });

  test("conflito de moeda lança erro de domínio", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test("equals é falso entre moedas diferentes, sem lançar", () => {
    expect(brl("1.00").equals(Money.from({ amount: "1.00", currency: "USD" }))).toBe(false);
  });

  test("imutável: add retorna nova instância", () => {
    const a = brl("1.00");
    const b = a.add(a);
    expect(a.amount).toBe("1.00");
    expect(b.amount).toBe("2.00");
    expect(b).not.toBe(a);
  });

  test("comparações", () => {
    expect(brl("1.00").isLessThan(brl("2.00"))).toBe(true);
    expect(brl("2.00").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(Money.zero("BRL").isPositive()).toBe(false);
    expect(brl("1.00").isPositive()).toBe(true);
  });

  test("toString e JSON.stringify", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
    expect(JSON.stringify({ m: brl("25.00") })).toBe('{"m":{"amount":"25.00","currency":"BRL"}}');
  });

  test("zero com moeda inválida é rejeitado", () => {
    expect(() => Money.zero("xx")).toThrow(InvalidMoneyError);
  });
});
