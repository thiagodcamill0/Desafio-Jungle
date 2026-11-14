import { DomainError } from "../domain/errors";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/wagering-events";
import type { EventContext, IntegrationEvent } from "../domain/events/integration-event";
import { FailureCode } from "../domain/failure-code";
import { InboxMessage } from "../domain/inbox-message";
import { Money, type MoneyProps } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { computePayloadHash, type WagerPayloadFields } from "../domain/payload-hash";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { ConflictError, InboxPayloadMismatchError, UniqueViolationError, ValidationError } from "./errors";
import type { Clock, IdGenerator, Repositories, TransactionRunner } from "./ports";
import { applyWager } from "./wager-rules";

export type SubmitWagerCommand = WagerPayloadFields & { idempotencyKey: string };

export interface SubmitOptions {
  correlationId: string;
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export interface SubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export type SubmitOutcome = SubmitResult | { duplicateInbox: true };

const KINDS = new Set<string>(Object.values(WagerTransactionKind));

// Caso de uso único para HTTP, SQS e worker de pendentes.
export class SubmitWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(cmd: SubmitWagerCommand, opts: SubmitOptions): Promise<SubmitOutcome> {
    const payloadHash = computePayloadHash(cmd);
    // valida o payload antes de abrir transação
    const first = this.newTransaction(cmd, payloadHash);
    try {
      return await this.runner.run((repos) => this.submit(repos, first, opts));
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      if (error.constraint === "ux_wager_provider_external") {
        throw new ConflictError(FailureCode.EXTERNAL_TRANSACTION_ID_REUSED, `${cmd.providerId}/${cmd.externalTransactionId} was already used with another idempotency key`);
      }
      // outra requisição gravou a mesma key: a segunda tentativa vira replay
      if (error.constraint === "ux_wager_idempotency_key") {
        return this.runner.run((repos) => this.submit(repos, this.newTransaction(cmd, payloadHash), opts));
      }
      throw error;
    }
  }

  async resolvePending(_transactionId: string, _correlationId: string): Promise<SubmitResult | null> {
    throw new Error("resolvePending: not implemented yet");
  }

  private async submit(repos: Repositories, tx: WagerTransaction, opts: SubmitOptions): Promise<SubmitOutcome> {
    const now = this.clock.now();
    const inbox = opts.inbox ? InboxMessage.receive({ ...opts.inbox, at: now }) : undefined;
    if (inbox) {
      const result = await repos.inbox.insertIfAbsent(inbox);
      if (!result.inserted) {
        if (result.payloadHash === inbox.payloadHash) return { duplicateInbox: true };
        throw new InboxPayloadMismatchError(inbox.messageId, inbox.consumerName);
      }
    }

    // trava a wallet antes de olhar a key: cópias simultâneas esperam aqui e depois viram replay
    const wallet = await repos.wallets.lockById(tx.walletId);
    if (!wallet) throw new DomainError(FailureCode.WALLET_NOT_FOUND, `Wallet ${tx.walletId} not found`);

    const existing = await repos.transactions.findByIdempotencyKey(tx.idempotencyKey);
    let result: SubmitResult;
    if (existing) {
      if (!existing.matchesPayload(tx.payloadHash)) {
        throw new ConflictError(FailureCode.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH, `Idempotency key ${tx.idempotencyKey} was used with a different payload`);
      }
      result = toResult(existing, true);
    } else {
      result = await this.decide(repos, wallet, tx, opts, now);
    }

    if (inbox) {
      inbox.markProcessed(now);
      await repos.inbox.save(inbox);
    }
    return result;
  }

  private async decide(repos: Repositories, wallet: Wallet, tx: WagerTransaction, opts: SubmitOptions, now: Date): Promise<SubmitResult> {
    if (tx.requiresReference() || tx.referenceExternalTransactionId !== undefined) {
      throw new Error("reference resolution: not implemented yet");
    }
    const { entry } = applyWager({ wallet, tx, ids: this.ids, now });

    await repos.transactions.insert(tx);
    if (entry) {
      await repos.ledger.insert(entry);
      await repos.wallets.save(wallet);
    }
    await this.enqueueEvents(repos, wallet, tx, entry, opts, now);
    return toResult(tx, false);
  }

  private async enqueueEvents(
    repos: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    opts: SubmitOptions,
    now: Date,
  ): Promise<void> {
    const ctx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: opts.correlationId,
      causationId: opts.inbox?.messageId,
      occurredAt: now,
    });
    const events: IntegrationEvent<unknown>[] = [];
    if (tx.status === WagerTransactionStatus.Processed) events.push(WagerTransactionProcessed.from(tx, ctx()));
    if (tx.status === WagerTransactionStatus.Rejected) events.push(WagerTransactionRejected.from(tx, ctx()));
    if (tx.status === WagerTransactionStatus.PendingReference) events.push(WagerTransactionPendingReference.from(tx, ctx()));
    if (entry) events.push(WalletBalanceChanged.from(wallet, entry, ctx()));
    for (const event of events) await repos.outbox.add(OutboxMessage.enqueue(event, now));
  }

  private newTransaction(cmd: SubmitWagerCommand, payloadHash: string): WagerTransaction {
    if (!KINDS.has(cmd.kind)) throw new ValidationError(FailureCode.INVALID_PAYLOAD, `Unknown kind ${cmd.kind}`);
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind as WagerTransactionKind,
      money: Money.from(cmd.money),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
  }
}

export function toResult(tx: WagerTransaction, idempotentReplay: boolean): SubmitResult {
  if (!tx.observedBalance) throw new Error(`Transaction ${tx.id} has no observed balance`);
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.observedBalance.toJSON(),
    ...(tx.failureCode && { failureCode: tx.failureCode }),
    idempotentReplay,
  };
}
