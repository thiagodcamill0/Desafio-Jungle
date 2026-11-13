import { MikroORM } from "@mikro-orm/postgresql";
import { mikroOrmOptions } from "../src/infrastructure/persistence/mikro-orm.config";
import { loadConfig } from "../src/infrastructure/config";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") throw new Error("usage: bun scripts/migrate.ts up|down");

const orm = await MikroORM.init(mikroOrmOptions(loadConfig()));
try {
  const executed = direction === "up" ? await orm.migrator.up() : await orm.migrator.down();
  console.log(`migrations ${direction}: ${executed.map((m) => m.name).join(", ") || "nothing to do"}`);
} finally {
  await orm.close();
}
