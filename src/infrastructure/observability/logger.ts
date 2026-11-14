import type { LoggerService } from "@nestjs/common";
import pino, { type DestinationStream, type Logger } from "pino";
import { pinoHttp } from "pino-http";
import { currentLogContext, runWithLogContext } from "./log-context";

const MAX_CORRELATION_ID_LENGTH = 128;

// Logs JSON; o contexto (correlationId, transactionId...) entra em toda linha via mixin.
// Valores financeiros e payloads nunca saem no log.
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "wagering-processor" },
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: () => ({ ...currentLogContext() }),
      redact: {
        paths: ["money", "*.money", "amount", "*.amount", "balance", "*.balance", "payload", "*.payload", "req.headers.authorization"],
        censor: "[redacted]",
      },
    },
    destination ?? pino.destination(1),
  );
}

type Level = "info" | "error" | "warn" | "debug" | "trace" | "fatal";

// Adapta o pino à interface de logger do Nest.
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]) {
    this.write("info", message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.write("error", message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write("warn", message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write("debug", message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write("trace", message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.write("fatal", message, params);
  }

  // o Nest passa o contexto como último parâmetro (e o stack antes dele, no error)
  private write(level: Level, message: unknown, params: unknown[]) {
    const context = typeof params.at(-1) === "string" ? (params.at(-1) as string) : undefined;
    const stack = level === "error" && params.length > 1 && typeof params[0] === "string" ? params[0] : undefined;
    if (message instanceof Error) {
      this.logger[level]({ context, err: message }, message.message);
    } else if (typeof message === "object" && message !== null) {
      this.logger[level]({ context, ...(stack && { stack }), ...message });
    } else {
      this.logger[level]({ context, ...(stack && { stack }) }, String(message));
    }
  }
}

// log de cada requisição (método, rota, status, duração), sem corpo
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    serializers: {
      req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req) => req.url?.startsWith("/health") === true || req.url === "/metrics" },
  });
}

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

// Usa o X-Correlation-Id recebido (ou cria um), devolve na resposta e abre o contexto de log da requisição.
export function correlationMiddleware(req: HttpRequest, res: HttpResponse, next: () => void): void {
  const incoming = req.headers["x-correlation-id"];
  const value = typeof incoming === "string" ? incoming.trim() : "";
  const correlationId = value && value.length <= MAX_CORRELATION_ID_LENGTH ? value : Bun.randomUUIDv7();
  res.setHeader("X-Correlation-Id", correlationId);
  runWithLogContext({ correlationId }, next);
}
