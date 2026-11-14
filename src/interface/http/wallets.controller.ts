import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { OpenWallet } from "../../application/open-wallet";
import { WalletQueries, type LedgerPageView } from "../../application/queries";
import { ReconcileWallet, type ReconciliationReport } from "../../application/reconcile-wallet";
import type { WalletView } from "../../application/views";
import { ledgerQuery, openWalletBody, parseInput, uuidParam } from "./dto";
import { ProviderAuthGuard } from "./provider-auth.guard";

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Headers("x-correlation-id") correlationId?: string): Promise<WalletView> {
    const input = parseInput(openWalletBody, body);
    return this.openWallet.execute({ ...input, correlationId });
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string): Promise<WalletView> {
    return this.queries.getWallet(parseInput(uuidParam, walletId));
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId") walletId: string, @Query() query: unknown): Promise<LedgerPageView> {
    return this.queries.getLedger(parseInput(uuidParam, walletId), parseInput(ledgerQuery, query));
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(parseInput(uuidParam, walletId));
  }
}
