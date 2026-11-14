import { expect } from "bun:test";
import type { Exec } from "./test-db";

// saldo gravado == último balance_after == soma dos créditos menos débitos
export async function assertLedgerMatchesBalance(sql: Exec, walletId: string): Promise<void> {
  const [row] = await sql(
    `select w.balance::text as stored,
            coalesce((select balance_after from wallet_ledger_entries where wallet_id = w.id order by seq desc limit 1), 0)::numeric(19,2)::text as last_after,
            coalesce((select sum(case when direction = 'CREDIT' then amount else -amount end) from wallet_ledger_entries where wallet_id = w.id), 0)::numeric(19,2)::text as summed
       from wallets w where w.id = $1`,
    [walletId],
  );
  expect(row, `wallet ${walletId} not found`).toBeDefined();
  expect(row.last_after).toBe(row.stored);
  expect(row.summed).toBe(row.stored);
}
