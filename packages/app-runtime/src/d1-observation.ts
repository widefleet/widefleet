import { z } from "zod";
import type { DatabaseObservation } from "./runtime-extension.ts";
import type { Json } from "./types.ts";

type Send = (
  endpoint: string,
  sql: string | string[],
  parameters: Json[],
  format?: string,
) => Promise<Json>;

const send = z.object({
  _send: z.custom<Send>((value) => z.function().safeParse(value).success),
});

const databaseInternals = z.object({
  alwaysPrimarySession: z.custom<D1DatabaseSession>(
    (value) =>
      z
        .object({ prepare: z.function(), batch: z.function(), getBookmark: z.function() })
        .safeParse(value).success,
  ),
});

const counter = z.number().int().nonnegative().nullish();

const result = z.object({
  success: z.boolean(),
  meta: z.object({ rows_read: counter, rows_written: counter }).nullish(),
});

const responseMetadata = z.union([result, z.array(result)]);

type Call = Omit<DatabaseObservation, "binding" | "operation">;

const measure = (response: Json | undefined, timestamp: number, statements: number): Call => {
  if (response === undefined)
    return { timestamp, statements, outcome: "error", rowsRead: null, rowsWritten: null };

  // Parse only the allowlisted metadata, never results, SQL, parameters or errors.
  const parsed = responseMetadata.safeParse(response);

  if (!parsed.success) throw new Error("D1 observation received an incompatible response");
  const results = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  let rowsRead: number | null = results.length === statements && statements > 0 ? 0 : null;
  let rowsWritten = rowsRead;

  for (const entry of results) {
    rowsRead =
      rowsRead !== null && entry.meta?.rows_read != null ? rowsRead + entry.meta.rows_read : null;
    rowsWritten =
      rowsWritten !== null && entry.meta?.rows_written != null
        ? rowsWritten + entry.meta.rows_written
        : null;
  }

  if (
    (rowsRead !== null && !Number.isSafeInteger(rowsRead)) ||
    (rowsWritten !== null && !Number.isSafeInteger(rowsWritten))
  )
    throw new Error("D1 observation counters exceed the supported range");

  return {
    timestamp,
    statements,
    outcome: results.some((entry) => !entry.success)
      ? "error"
      : results.length === statements && statements > 0
        ? "ok"
        : "unknown",
    rowsRead,
    rowsWritten,
  };
};

export const observeDatabase = (
  nativeDatabase: D1Database,
  context: Pick<ExecutionContext, "waitUntil">,
  observe: (event: Call) => Promise<void>,
) => {
  const unavailable = () => {
    context.waitUntil(
      Promise.reject(new Error("D1 observation unavailable: incompatible native binding")),
    );
  };

  const observeSession = (session: D1DatabaseSession) => {
    const parsed = send.safeParse(session);

    if (!parsed.success) throw new Error("D1 observation requires the native session _send");
    const nativeSend = parsed.data._send;

    Object.defineProperty(session, "_send", {
      async value(this: D1DatabaseSession, ...args: Parameters<Send>) {
        const timestamp = Date.now();
        const statements = Array.isArray(args[1]) ? args[1].length : 1;
        let response: Json | undefined;

        try {
          response = await nativeSend.apply(this, args);

          return response;
        } finally {
          // Keep the original response identity and native error/projection path.
          // Parsing/delivery failures reject background work, never the SQL call.
          context.waitUntil(
            Promise.resolve().then(() => observe(measure(response, timestamp, statements))),
          );
        }
      },
    });

    return session;
  };

  // Only adapter setup can fall back. SQL execution is outside these catches,
  // so a result or native error can never cause a query to run a second time.
  try {
    const parsed = databaseInternals.safeParse(nativeDatabase);

    if (!parsed.success) throw new Error("D1 observation requires the native primary session");
    // SAFETY: Each view inherits the complete native instance. Only invocation-local
    // properties are added; neither the shared binding nor its prototypes are edited.
    const database = Object.create(nativeDatabase) as D1Database;
    // SAFETY: This view inherits the validated native session's methods and state.
    const primary = Object.create(parsed.data.alwaysPrimarySession) as D1DatabaseSession;

    Object.defineProperty(database, "alwaysPrimarySession", { value: observeSession(primary) });
    Object.defineProperty(database, "withSession", {
      value: (bookmark?: string) => {
        const session = nativeDatabase.withSession(bookmark);

        try {
          return observeSession(session);
        } catch {
          unavailable();

          return session;
        }
      },
    });

    return database;
  } catch {
    unavailable();

    return nativeDatabase;
  }
};
