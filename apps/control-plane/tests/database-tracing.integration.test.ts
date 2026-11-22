import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDatabase, type DatabaseSpan } from "../src/lib/server/database.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Database tracing", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

  beforeAll(async () => {
    environment = await createTestEnvironment();
  });

  afterAll(async () => {
    await environment?.close();
  });

  it("records each connection and statement with its outcome", async () => {
    const spans: { name: string; attributes: Record<string, string>; error?: unknown }[] = [];
    let open = 0;

    const span: DatabaseSpan = (name, attributes) => {
      const entry: (typeof spans)[number] = { name, attributes };
      spans.push(entry);
      open += 1;

      return (error) => {
        entry.error = error;
        open -= 1;
      };
    };

    const database = createDatabase(environment.configuration, 1, span);

    try {
      await database.db.execute(sql`select ${"private value"}::text as value`);
      await database.db.transaction((transaction) => transaction.execute(sql`select 1`));
      await expect(database.db.execute(sql`select * from missing_table`)).rejects.toThrow();
    } finally {
      await database.close();
    }

    expect(open).toBe(0);
    expect(spans.filter((entry) => entry.name === "postgres connect")).toHaveLength(1);

    expect(
      spans.flatMap((entry) =>
        entry.name === "postgres query" ? [entry.attributes["db.query.text"]] : [],
      ),
    ).toEqual([
      "select $1::text as value",
      "begin",
      "select 1",
      "commit",
      "select * from missing_table",
    ]);

    expect(JSON.stringify(spans)).not.toContain("private value");
    expect(spans.at(-1)?.error).toBeInstanceOf(Error);
    expect(spans.slice(0, -1).every((entry) => entry.error === undefined)).toBe(true);
  });
});
