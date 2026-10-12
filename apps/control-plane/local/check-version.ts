import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readConfiguration } from "../src/lib/server/config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { requireLocal } from "./settings.ts";

requireLocal();

const database = createDatabase(readConfiguration());

try {
  const table = await database.db.execute(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`,
  );

  if (z.array(z.object({ name: z.string().nullable() })).parse(table.rows)[0]?.name) {
    const applied = await database.db.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations`);

    const available = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });

    if (
      z
        .array(z.object({ hash: z.string() }))
        .parse(applied.rows)
        .some((entry) => !available.some((migration) => migration.hash === entry.hash))
    )
      throw new Error(
        "This demo database contains migrations absent from the selected version. Use ./dev up --build from the matching source checkout, or wait for its release.",
      );
  }
} finally {
  await database.close();
}
