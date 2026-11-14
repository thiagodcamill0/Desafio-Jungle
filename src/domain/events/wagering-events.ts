import { InvalidTransactionStateError } from "../errors";
import type { FailureCode } from "../failure-code";
import type { Money, MoneyProps } from "../money";
import type { WagerTransaction } from "../wager-transaction";
import type { Wallet } from "../wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../wallet-ledger-entry";
import { IntegrationEvent, type EventContext } from "./integration-event";

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  /** Saldo da wallet no momento da decisão. */
  balance: MoneyProps;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** Permite ao consumidor ordenar eventos da mesma wallet. */
  walletVersion: number;
}

/** Aplicada (inclusive LOSS, que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.walletId, data: transactionData(tx) });
  }
}

/** Rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new InvalidTransactionStateError(`WagerTransactionRejected: transaction ${tx.id} has no failureCode`);
    return new WagerTransactionRejected({ ...ctx, aggregateId: tx.walletId, data: { ...transactionData(tx), failureCode: tx.failureCode } });
  }
}

/** Aguardando a transação referenciada chegar. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const reference = tx.referenceExternalTransactionId;
    if (!reference) throw new InvalidTransactionStateError(`WagerTransactionPendingReference: transaction ${tx.id} has no reference`);
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...transactionData(tx), referenceExternalTransactionId: reference },
    });
  }
}

/** Emitido somente quando o saldo muda — sempre a partir de um lançamento do ledger. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: props(entry.money),
        balanceBefore: props(entry.balanceBefore),
        balanceAfter: props(entry.balanceAfter),
        walletVersion: wallet.version,
      },
    });
  }
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
  const balance = tx.observedBalance;
  if (!balance) throw new InvalidTransactionStateError(`Event for transaction ${tx.id} requires a decided transaction (no observed balance)`);
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    kind: tx.kind,
    money: props(tx.money),
    balance: props(balance),
  };
}

const props = (money: Money): MoneyProps => money.toJSON();
