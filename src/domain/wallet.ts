import { BalanceLimitExceededError, CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from "./errors";
import { Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface BalanceMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

const MAX_BALANCE = "99999999999999999.99";

// Único lugar que mexe no saldo; todo débito/crédito devolve o lançamento do ledger.
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) throw new InvalidMoneyError("Initial balance cannot be negative");
    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, at, at);
    if (initialBalance.isZero()) return { wallet };
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(`Insufficient funds: balance ${this._balance}, requested ${movement.money}`);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    const maxBalance = Money.from({ amount: MAX_BALANCE, currency: this.currency });
    if (maxBalance.isLessThan(this._balance.add(movement.money))) {
      throw new BalanceLimitExceededError(`Credit of ${movement.money} would exceed the maximum balance`);
    }
    return this.apply(LedgerDirection.Credit, movement);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  // cria o lançamento antes de mudar o saldo; se falhar, a wallet fica como estava
  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const balanceAfter =
      direction === LedgerDirection.Credit ? this._balance.add(movement.money) : this._balance.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new InvalidMoneyError("Movement amount must be positive");
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
