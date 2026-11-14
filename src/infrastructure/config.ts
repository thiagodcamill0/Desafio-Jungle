export type AppRole = "api" | "consumer" | "outbox" | "pending";

const ALL_ROLES: readonly AppRole[] = ["api", "consumer", "outbox", "pending"];

export interface AppConfig {
  port: number;
  databaseUrl: string;
  sqsEndpoint: string;
  awsRegion: string;
  wagerQueueName: string;
  wagerDlqName: string;
  eventsQueueName: string;
  roles: Set<AppRole>;
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
  faultPoint?: string;
  logLevel: string;
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  return value;
}

function parseRoles(raw: string | undefined): Set<AppRole> {
  if (!raw) return new Set(ALL_ROLES);
  const roles = raw.split(",").map((r) => r.trim()).filter(Boolean);
  for (const role of roles) {
    if (!ALL_ROLES.includes(role as AppRole)) throw new Error(`Unknown APP_ROLES entry: ${role}`);
  }
  return new Set(roles as AppRole[]);
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    port: int(env, "PORT", 3000),
    databaseUrl: env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering",
    sqsEndpoint: env.SQS_ENDPOINT ?? "http://localhost:4566",
    awsRegion: env.AWS_REGION ?? "us-east-1",
    wagerQueueName: env.WAGER_QUEUE_NAME ?? "wager-transactions.fifo",
    wagerDlqName: env.WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo",
    eventsQueueName: env.EVENTS_QUEUE_NAME ?? "wagering-events.fifo",
    roles: parseRoles(env.APP_ROLES),
    visibilityTimeoutSeconds: int(env, "VISIBILITY_TIMEOUT_SECONDS", 30),
    maxReceiveCount: int(env, "MAX_RECEIVE_COUNT", 5),
    faultPoint: env.FAULT_POINT || undefined,
    logLevel: env.LOG_LEVEL || "info",
  };
}
