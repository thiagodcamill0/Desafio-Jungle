import { WalletBalanceChanged } from "../domain/events/wagering-events";
import { FailureCode } from "../domain/failure-code";
import { Money, type MoneyProps } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { ConflictError, UniqueViolationError } from "./errors";
import type { Clock, IdGenerator, TransactionRunner } from "./ports";
import { toWalletView, type WalletView } from "./views";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

// Cria a wallet; saldo inicial > 0 vira uma transação OPENING com crédito no ledger, tudo no mesmo commit.
export class OpenWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(cmd: OpenWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);
    const now = this.clock.now();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: cmd.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.next(),
      at: now,
    });

    try {
      await this.runner.run(async (repos) => {
        await repos.wallets.insert(wallet);
        if (!openingEntry) return;

        const opening = WagerTransaction.createOpening({ id: openingTransactionId, walletId: wallet.id, playerId: wallet.playerId, money: initialBalance, at: now });
        opening.markProcessed(undefined, wallet.balance, now);
        await repos.transactions.insert(opening);
        await repos.ledger.insert(openingEntry);

        const event = WalletBalanceChanged.from(wallet, openingEntry, {
          eventId: this.ids.next(),
          correlationId: cmd.correlationId ?? opening.id,
          occurredAt: now,
        });
        await repos.outbox.add(OutboxMessage.enqueue(event, now));
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === "ux_wallets_player_currency") {
        throw new ConflictError(FailureCode.WALLET_ALREADY_EXISTS, `Player ${cmd.playerId} already has a ${initialBalance.currency} wallet`);
      }
      throw error;
    }
    return toWalletView(wallet);
  }
}
