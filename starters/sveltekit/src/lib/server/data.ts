import { env } from "cloudflare:workers";
import { Result, TaggedError } from "better-result";
import { z } from "zod";

export class DataUnavailable extends TaggedError("DataUnavailable")<{
  message: string;
  cause: unknown;
}> {}

const note = z.object({
  id: z.uuid(),
  author: z.string(),
  message: z.string(),
  photo: z.string().nullable(),
  created_at: z.string(),
});

export const database = () =>
  Result.tryPromise({
    try: async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, author TEXT NOT NULL, message TEXT NOT NULL, photo TEXT, created_at TEXT NOT NULL)",
      ).run();

      return env.DB;
    },
    catch: (cause) =>
      new DataUnavailable({ message: "Die Datenbank ist gerade nicht erreichbar.", cause }),
  });

export const listNotes = () =>
  Result.gen(async function* () {
    const db = yield* Result.await(database());

    return Result.tryPromise({
      try: async () => {
        const result = await db
          .prepare(
            "SELECT id, author, message, photo, created_at FROM notes ORDER BY created_at DESC LIMIT 100",
          )
          .all();

        return z.array(note).parse(result.results);
      },
      catch: (cause) =>
        new DataUnavailable({ message: "Notizen konnten nicht geladen werden.", cause }),
    });
  });
