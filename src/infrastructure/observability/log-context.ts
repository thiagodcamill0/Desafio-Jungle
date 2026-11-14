import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

// tudo que rodar dentro de fn (inclusive código assíncrono) enxerga esse contexto nos logs
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

export function addToLogContext(fields: Partial<LogContext>): void {
  const context = storage.getStore();
  if (context) Object.assign(context, fields);
}
