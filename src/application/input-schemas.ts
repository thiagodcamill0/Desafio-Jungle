import { z } from "zod";
import { FailureCode } from "../domain/failure-code";
import type { MoneyProps } from "../domain/money";
import { ValidationError } from "./errors";

// Schemas de entrada compartilhados por HTTP e SQS.

// amount e currency passam crus: quem valida formato de dinheiro é o Money (INVALID_MONEY)
export const moneyInput = z.object({ amount: z.unknown(), currency: z.unknown() }).transform((m) => m as MoneyProps);

// limite e NUL barrados aqui: o Postgres recusa NUL e índices únicos não aceitam strings enormes
export const MAX_TEXT_LENGTH = 255;
export const text = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TEXT_LENGTH)
  .refine((value) => !value.includes("\u0000"), "must not contain NUL characters");

// kind segue como texto: o caso de uso distingue kind desconhecido (INVALID_PAYLOAD) de OPENING (KIND_NOT_ALLOWED)
export const wagerFields = z.object({
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

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  throw new ValidationError(FailureCode.INVALID_PAYLOAD, `${where}${issue?.message ?? "invalid input"}`);
}
