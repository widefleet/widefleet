import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Configuration } from "./config.ts";
import * as schema from "./schema.ts";

type SpanEnd = (error?: Error) => void;

type DatabaseSpanAttributes = {
  readonly "db.system.name": "postgresql";
  readonly "db.query.text"?: string;
};

// Starts a span for one database operation and returns the function that ends it.
export type DatabaseSpan = (name: string, attributes: DatabaseSpanAttributes) => SpanEnd;

type QueryInput = string | pg.QueryConfig;

type QueryCallback = (error: Error | undefined, result: pg.QueryResult) => void;

type QueryValues = pg.QueryConfigValues<unknown[]>;

type Query = (
  input: QueryInput,
  values?: QueryValues | QueryCallback,
  callback?: QueryCallback,
) => Promise<pg.QueryResult> | undefined;

const settle = <T>(result: Promise<T>, end: SpanEnd) =>
  result.then(
    (value) => {
      end();

      return value;
    },
    (error: Error) => {
      end(error);
      throw error;
    },
  );

const system = { "db.system.name": "postgresql" } as const;

// Every query runs through a pooled client, whichever library builds it, so one hook covers
// Drizzle, Better Auth and raw SQL. Statements carry placeholders, never their values.
const tracedClient = (span: DatabaseSpan) =>
  class TracedClient extends pg.Client {
    constructor(config?: string | pg.ClientConfig) {
      super(config);
      const connect = this.connect.bind(this);

      // SAFETY: The wrapper keeps both Client.connect forms and returns what they return.
      this.connect = ((callback?: (error: Error | undefined) => void) => {
        const end = span("postgres connect", system);

        if (!callback) return settle(connect(), end);

        return connect((error: Error) => {
          end(error ?? undefined);
          callback(error ?? undefined);
        });
      }) as typeof this.connect;

      // SAFETY: Drizzle and pg-pool call query with a statement, optional values and an optional
      // callback; the wrapper forwards them unchanged and returns what Client.query returns.
      const query = this.query.bind(this) as Query;

      const traced: Query = (input, values, callback) => {
        const end = span("postgres query", {
          ...system,
          "db.query.text": (input instanceof Object ? input.text : input).slice(0, 500),
        });

        const done = callback ?? (values instanceof Function ? values : undefined);

        if (done)
          return query(input, values instanceof Function ? undefined : values, (error, result) => {
            end(error ?? undefined);
            done(error, result);
          });

        const result = query(input, values);

        return result && settle(result, end);
      };

      // SAFETY: See above; streams and other submittables are not used with this pool.
      this.query = traced as typeof this.query;
    }
  };

export const createDatabase = (configuration: Configuration, max = 10, span?: DatabaseSpan) => {
  const pool = new pg.Pool({
    ...(span && { Client: tracedClient(span) }),
    connectionString: configuration.DATABASE_URL,
    max,
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
