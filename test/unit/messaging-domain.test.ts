import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/domain/failure-code";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { WagerTransaction, WagerTransactionKind } from "../../src/domain/wager-transaction";
import { InboxMessage } from "../../src/domain/inbox-message";
import { OutboxMessage } from "../../src/domain/outbox-message";
import { IntegrationEvent, type EventContext } from "../../src/domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../src/domain/events/wagering-events";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-11-13T10:00:00.000Z");
const T1 = new Date("2026-11-13T10:00:01.000Z");
const ctx: EventContext = { eventId: "evt-1", correlationId: "corr-1", causationId: "msg-1", occurredAt: T1 };

const tx = (kind: WagerTransactionKind, amount: string, referenceExternalTransactionId?: string) =>
  WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash",
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind,
    money: brl(amount),
    referenceExternalTransactionId,
    createdAt: T0,
  });

describe("WalletBalanceChanged", () => {
  const { wallet } = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("100.00"), openingTransactionId: "t0", openingEntryId: "e0", at: T0 });
  const entry = wallet.debit({ money: brl("80.00"), transactionId: "tx-1", entryId: "e1", at: T1 });
  const event = WalletBalanceChanged.from(wallet, entry, ctx);

  test("é uma subclasse de IntegrationEvent com eventType e version no tipo", () => {
    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe("w1");
  });

  test("toJSON: envelope completo, occurredAt ISO e dinheiro como string", () => {
    const json = event.toJSON();
    expect(json).toEqual({
      eventId: "evt-1",
      eventType: "WalletBalanceChanged",
      aggregateId: "w1",
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-11-13T10:00:01.000Z",
      version: 1,
      data: {
        walletId: "w1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: { amount: "80.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "20.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
    expect(json.data.money).not.toBeInstanceOf(Money);
    expect(JSON.parse(JSON.stringify(json)).data.direction).toBe("DEBIT");
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("causationId ausente não aparece no JSON", () => {
    const { causationId: _, ...withoutCausation } = ctx;
    expect("causationId" in WalletBalanceChanged.from(wallet, entry, withoutCausation).toJSON()).toBe(false);
  });
});

describe("eventos da transação", () => {
  test("WagerTransactionProcessed carrega o saldo observado na decisão", () => {
    const bet = tx(WagerTransactionKind.Bet, "80.00");
    bet.markProcessed(undefined, brl("20.00"), T1);
    const json = WagerTransactionProcessed.from(bet, ctx).toJSON();
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.aggregateId).toBe("w1");
    expect(json.data).toEqual({
      transactionId: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      walletId: "w1",
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
      balance: { amount: "20.00", currency: "BRL" },
    });
  });

  test("WagerTransactionRejected inclui o failureCode", () => {
    const bet = tx(WagerTransactionKind.Bet, "80.00");
    bet.reject(FailureCode.INSUFFICIENT_FUNDS, brl("20.00"), T1);
    const json = WagerTransactionRejected.from(bet, ctx).toJSON();
    expect(json.eventType).toBe("WagerTransactionRejected");
    expect(json.data.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(json.data.balance).toEqual({ amount: "20.00", currency: "BRL" });
  });

  test("WagerTransactionPendingReference inclui a referência esperada", () => {
    const refund = tx(WagerTransactionKind.Refund, "80.00", "bet-ext-9");
    refund.markPendingReference(brl("20.00"), T1);
    const json = WagerTransactionPendingReference.from(refund, ctx).toJSON();
    expect(json.eventType).toBe("WagerTransactionPendingReference");
    expect(json.data.referenceExternalTransactionId).toBe("bet-ext-9");
  });

  test("evento de transação sem decisão (sem saldo observado) é erro de programação", () => {
    expect(() => WagerTransactionProcessed.from(tx(WagerTransactionKind.Bet, "1.00"), ctx)).toThrow();
  });
});

describe("OutboxMessage", () => {
  const event = () => {
    const bet = tx(WagerTransactionKind.Bet, "80.00");
    bet.markProcessed(undefined, brl("20.00"), T1);
    return WagerTransactionProcessed.from(bet, ctx);
  };

  test("enqueue copia o envelope do evento e nasce pendente e vencido", () => {
    const msg = OutboxMessage.enqueue(event(), T1);
    expect(msg.id).toBe("evt-1");
    expect(msg.aggregateId).toBe("w1");
    expect(msg.eventType).toBe("WagerTransactionProcessed");
    expect(msg.payload as unknown).toEqual(event().toJSON());
    expect(msg.occurredAt).toEqual(T1);
    expect(msg.attempts).toBe(0);
    expect(msg.nextAttemptAt).toEqual(T1);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T1)).toBe(true);
  });

  test("scheduleRetry: attempts 1 → próxima tentativa em +2s", () => {
    const msg = OutboxMessage.enqueue(event(), T1);
    msg.scheduleRetry(T1);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt).toEqual(new Date(T1.getTime() + 2_000));
    expect(msg.isDue(new Date(T1.getTime() + 1_999))).toBe(false);
    expect(msg.isDue(new Date(T1.getTime() + 2_000))).toBe(true);
  });

  test("scheduleRetry: backoff exponencial com teto de 60s", () => {
    const msg = OutboxMessage.enqueue(event(), T1);
    for (let i = 0; i < 10; i++) msg.scheduleRetry(T1);
    expect(msg.attempts).toBe(10);
    expect(msg.nextAttemptAt).toEqual(new Date(T1.getTime() + 60_000));
  });

  test("markPublished: deixa de estar pendente e nunca mais vence", () => {
    const msg = OutboxMessage.enqueue(event(), T1);
    msg.markPublished(T1);
    expect(msg.isPending()).toBe(false);
    expect(msg.publishedAt).toEqual(T1);
    expect(msg.isDue(new Date(T1.getTime() + 3_600_000))).toBe(false);
  });

  test("rehydrate preserva o estado persistido", () => {
    const original = OutboxMessage.enqueue(event(), T1);
    original.scheduleRetry(T1);
    const copy = OutboxMessage.rehydrate(original.toState());
    expect(copy.toState()).toEqual(original.toState());
  });
});

describe("InboxMessage", () => {
  test("receive nasce não processada; markProcessed processa", () => {
    const msg = InboxMessage.receive({ messageId: "m1", consumerName: "wager-consumer", payloadHash: "h", at: T0 });
    expect(msg.receivedAt).toEqual(T0);
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(T1);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(T1);
  });

  test("rehydrate preserva o estado persistido", () => {
    const msg = InboxMessage.receive({ messageId: "m1", consumerName: "wager-consumer", payloadHash: "h", at: T0 });
    msg.markProcessed(T1);
    expect(InboxMessage.rehydrate(msg.toState()).toState()).toEqual(msg.toState());
  });
});
