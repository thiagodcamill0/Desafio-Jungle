import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import type { AppConfig } from "../config";

export function mikroOrmOptions(config: Pick<AppConfig, "databaseUrl">) {
  return defineConfig({
    clientUrl: config.databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: [],
      transactional: true,
      allOrNothing: true,
    },
    pool: { min: 0, max: 20 },
    debug: false,
  });
}
