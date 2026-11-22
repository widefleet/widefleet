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

  const recorder = () => {
    const spans: {
      name: string;
      attributes: Record<string, string>;
      failure?: { type: string };
    }[] = [];

    let open = 0;

    const span: DatabaseSpan = (name, attributes) => {
      const entry: (typeof spans)[number] = { name, attributes };
      spans.push(entry);
      open += 1;

      return (failure) => {
        if (failure) entry.failure = failure;
        open -= 1;
      };
    };

    return { spans, span, open: () => open };
  };

  it("records each connection and statement with its outcome", async () => {
    const { spans, span, open } = recorder();
    const database = createDatabase(environment.configuration, 1, span);

    try {
      await database.db.execute(sql`select ${"private value"}::text as value`);
      await database.db.transaction((transaction) => transaction.execute(sql`select 1`));
      await expect(database.db.execute(sql`select * from missing_table`)).rejects.toThrow();
      // PostgreSQL quotes the rejected value in its error message.
      await expect(database.db.execute(sql`select ${"private number"}::integer`)).rejects.toThrow(
        "private number",
      );
    } finally {
      await database.close();
    }

    expect(open()).toBe(0);
    // The pool discards a client after a failed query, so the last statement connects again.
    expect(spans.filter((entry) => entry.name === "postgres connect")).toHaveLength(2);

    expect(
      spans.flatMap((entry) =>
        entry.name === "postgres query" ? [[entry.attributes["db.query.text"], entry.failure]] : [],
      ),
    ).toEqual([
      ["select $1::text as value", undefined],
      ["begin", undefined],
      ["select 1", undefined],
      ["commit", undefined],
      ["select * from missing_table", { type: "42P01" }],
      ["select $1::integer", { type: "22P02" }],
    ]);

    expect(JSON.stringify(spans)).not.toMatch(/private (value|number)/);
  });

  it("records a rejected connection", async () => {
    const { spans, span, open } = recorder();
    const address = new URL(environment.configuration.DATABASE_URL);
    address.password = "wrong-password";

    const database = createDatabase(
      { ...environment.configuration, DATABASE_URL: address.href },
      1,
      span,
    );

    try {
      await expect(database.db.execute(sql`select 1`)).rejects.toThrow();
    } finally {
      await database.close();
    }

    expect(open()).toBe(0);
    expect(spans).toEqual([
      {
        name: "postgres connect",
        attributes: { "db.system.name": "postgresql" },
        failure: { type: "28P01" },
      },
    ]);
  });
});
