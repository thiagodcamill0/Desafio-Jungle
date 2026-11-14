import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import type { AppConfig } from "../config";
import { Migration20261113000000 } from "./migrations/Migration20261113000000";

export function mikroOrmOptions(config: Pick<AppConfig, "databaseUrl">) {
  return defineConfig({
    clientUrl: config.databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: [{ name: "Migration20261113000000", class: Migration20261113000000 }],
      transactional: true,
      allOrNothing: true,
    },
    pool: { min: 0, max: 20 },
    debug: false,
  });
}
