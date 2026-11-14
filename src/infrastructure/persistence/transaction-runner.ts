import { ConnectionException, type MikroORM } from "@mikro-orm/postgresql";
import { ConcurrencyError, TransientInfraError, UniqueViolationError } from "../../application/errors";
import type { Metrics, Repositories, TransactionRunner } from "../../application/ports";
import { FailureCode } from "../../domain/failure-code";
import { repositoriesFor } from "./repositories";

export interface TransactionRunnerOptions {
  lockTimeoutMs: number;
}

const LOCK_CODES = new Set(["55P03", "40P01"]);
const CONNECTION_CODES = new Set(["57P01", "57P02", "57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);

// Abre uma transação por chamada, com lock_timeout, e traduz erros do driver para erros da aplicação.
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: TransactionRunnerOptions = { lockTimeoutMs: 5_000 },
    private readonly metrics?: Metrics,
  ) {}

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${Math.trunc(this.options.lockTimeoutMs)}ms'`);
        return work(repositoriesFor(em, this.metrics));
      });
    } catch (error) {
      const translated = translateDatabaseError(error);
      if (translated instanceof TransientInfraError && translated.code === FailureCode.LOCK_TIMEOUT) this.metrics?.inc("lock_conflicts_total", { reason: "timeout" });
      if (translated instanceof ConcurrencyError) this.metrics?.inc("lock_conflicts_total", { reason: "version" });
      throw translated;
    }
  }
}

export function translateDatabaseError(error: unknown): unknown {
  const code = sqlState(error);
  if (code === "23505") return new UniqueViolationError(String((error as { constraint?: string }).constraint ?? "unknown"), error);
  if (code && LOCK_CODES.has(code)) return new TransientInfraError(FailureCode.LOCK_TIMEOUT, "Timed out waiting for a row lock", error);
  if (error instanceof ConnectionException || (code && (CONNECTION_CODES.has(code) || code.startsWith("08")))) {
    return new TransientInfraError(FailureCode.DATABASE_UNAVAILABLE, "Database unavailable", error);
  }
  return error;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, sqlState: state, cause } = error as { code?: unknown; sqlState?: unknown; cause?: unknown };
  if (typeof state === "string") return state;
  if (typeof code === "string") return code;
  return cause ? sqlState(cause) : undefined;
}
