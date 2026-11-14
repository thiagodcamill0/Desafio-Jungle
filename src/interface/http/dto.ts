import { z } from "zod";
import { moneyInput, wagerFields } from "../../application/input-schemas";

export { parseInput } from "../../application/input-schemas";

export const openWalletBody = z.object({
  playerId: z.uuid(),
  initialBalance: moneyInput,
});

export const wagerBody = wagerFields;

export const uuidParam = z.uuid();

export const ledgerQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
