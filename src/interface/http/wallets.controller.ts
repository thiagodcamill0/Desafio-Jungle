import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { OpenWallet } from "../../application/open-wallet";
import { WalletQueries } from "../../application/queries";
import type { WalletView } from "../../application/views";
import { openWalletBody, parseInput, uuidParam } from "./dto";
import { ProviderAuthGuard } from "./provider-auth.guard";

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
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
}
