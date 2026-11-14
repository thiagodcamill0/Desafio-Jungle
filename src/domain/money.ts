import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

// até 17 dígitos inteiros e 2 casas: cabe em NUMERIC(19,2)
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})\.(\d{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 100n;

// Guarda centavos em bigint. Entrada fora do formato é rejeitada, nunca arredondada.
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {}

  // só aceita valores não negativos
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== "string") throw new InvalidMoneyError("amount must be a decimal string");
    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) throw new InvalidMoneyError(`Invalid amount "${amount}": expected format 0.00 with exactly 2 decimals`);
    const [, integerPart, fractionPart] = match as unknown as [string, string, string];
    return new Money(BigInt(integerPart) * SCALE + BigInt(fractionPart), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  get amount(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const fraction = (abs % SCALE).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${abs / SCALE}.${fraction}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private static assertCurrency(currency: string): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${currency}": expected ISO-4217 code like BRL`);
    }
    return currency;
  }
}
