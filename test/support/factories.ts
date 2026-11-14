import type { SubmitWagerCommand } from "../../src/application/submit-wager-transaction";
import { getJson, postJson } from "./test-app";
import type { Exec } from "./test-db";

export async function openWallet(baseUrl: string, amount: string, currency = "BRL"): Promise<{ walletId: string; playerId: string }> {
  const playerId = crypto.randomUUID();
  const res = await postJson(`${baseUrl}/wallets`, { playerId, initialBalance: { amount, currency } });
  if (res.status !== 201) throw new Error(`openWallet failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}

export function wager(overrides: Partial<SubmitWagerCommand> & { amount?: string; currency?: string } = {}): SubmitWagerCommand {
  const { amount = "10.00", currency = "BRL", ...rest } = overrides;
  const providerId = rest.providerId ?? "provider-a";
  const externalTransactionId = rest.externalTransactionId ?? `ext-${crypto.randomUUID()}`;
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: crypto.randomUUID(),
    walletId: crypto.randomUUID(),
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: { amount, currency },
    ...rest,
  };
}

export function postWager(baseUrl: string, cmd: SubmitWagerCommand) {
  const { idempotencyKey, ...body } = cmd;
  return postJson(`${baseUrl}/wagering/transactions`, body, { "Idempotency-Key": idempotencyKey });
}

export async function getWallet(baseUrl: string, walletId: string) {
  return (await getJson(`${baseUrl}/wallets/${walletId}`)).body;
}

export async function countLedger(sql: Exec, walletId: string, direction?: "DEBIT" | "CREDIT"): Promise<number> {
  const rows = direction
    ? await sql(`select count(*)::int as n from wallet_ledger_entries where wallet_id = $1 and direction = $2`, [walletId, direction])
    : await sql(`select count(*)::int as n from wallet_ledger_entries where wallet_id = $1`, [walletId]);
  return rows[0].n;
}
