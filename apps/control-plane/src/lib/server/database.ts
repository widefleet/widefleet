import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Configuration } from "./config.ts";
import * as schema from "./schema.ts";

export const createDatabase = (configuration: Configuration) => {
  const pool = new pg.Pool({
    connectionString: configuration.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });

  pool.on("error", (error) => {
    console.error("PostgreSQL connection failed", error.message);
  });

  return { db: drizzle(pool, { schema }), close: () => pool.end() };
};

export type Database = ReturnType<typeof createDatabase>["db"];

export type DatabaseExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
