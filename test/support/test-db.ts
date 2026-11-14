import { SQL } from "bun";
import { MikroORM } from "@mikro-orm/postgresql";
import { mikroOrmOptions } from "../../src/infrastructure/persistence/mikro-orm.config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Exec = (q: string, params?: unknown[]) => Promise<any[]>;

export interface TestDatabase {
  url: string;
  sql: Exec;
  /** Executa várias instruções na mesma transação SQL. */
  tx<T>(fn: (sql: Exec) => Promise<T>): Promise<T>;
  migrateUp(): Promise<void>;
  migrateDown(): Promise<void>;
  drop(): Promise<void>;
}

const adminUrl = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
  return url;
};

/** Cria um database isolado `wagering_test_<ts>_<rand>`, aplica as migrations e devolve um cliente SQL cru. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `wagering_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new SQL(adminUrl());
  await admin.unsafe(`create database ${name}`);

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const dbUrl = url.toString();

  const orm = await MikroORM.init(mikroOrmOptions({ databaseUrl: dbUrl }));
  await orm.migrator.up();
  const client = new SQL(dbUrl);

  return {
    url: dbUrl,
    sql: exec(client),
    tx: (fn) => client.begin((tx) => fn(exec(tx as unknown as SQL))) as never,
    migrateUp: async () => void (await orm.migrator.up()),
    migrateDown: async () => void (await orm.migrator.down({ to: 0 })),
    drop: async () => {
      await client.close();
      await orm.close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.close();
    },
  };
}

const exec =
  (client: SQL): Exec =>
  (q, params) =>
    params ? client.unsafe(q, params as never[]) : client.unsafe(q);
