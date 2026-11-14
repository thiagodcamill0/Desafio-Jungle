import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import type { AppConfig } from "../config";
import { Migration20261113000000 } from "./migrations/Migration20261113000000";
import { Migration20261114000000 } from "./migrations/Migration20261114000000";
import { persistenceSchemas } from "./schemas";

export function mikroOrmOptions(config: Pick<AppConfig, "databaseUrl">) {
  return defineConfig({
    clientUrl: config.databaseUrl,
    entities: persistenceSchemas,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        { name: "Migration20261113000000", class: Migration20261113000000 },
        { name: "Migration20261114000000", class: Migration20261114000000 },
      ],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
    },
    pool: { min: 0, max: 20 },
    debug: false,
  });
}
