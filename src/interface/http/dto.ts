import { z } from "zod";
import { FailureCode } from "../../domain/failure-code";
import type { MoneyProps } from "../../domain/money";
import { ValidationError } from "../../application/errors";

// amount e currency passam crus: quem valida formato de dinheiro é o Money (INVALID_MONEY)
export const moneyInput = z.object({ amount: z.unknown(), currency: z.unknown() }).transform((m) => m as MoneyProps);

export const openWalletBody = z.object({
  playerId: z.uuid(),
  initialBalance: moneyInput,
});

export const uuidParam = z.uuid();

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  throw new ValidationError(FailureCode.INVALID_PAYLOAD, `${where}${issue?.message ?? "invalid input"}`);
}

const text = z.string().trim().min(1);

// kind segue como texto: o caso de uso distingue kind desconhecido (INVALID_PAYLOAD) de OPENING (KIND_NOT_ALLOWED)
export const wagerBody = z.object({
  providerId: text,
  externalTransactionId: text,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: text,
  gameId: text,
  kind: text,
  money: moneyInput,
  referenceExternalTransactionId: text.optional(),
});
