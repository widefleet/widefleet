import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { migrationRequest } from "@platform/contracts";
import { createCloudflareProvisioner } from "../src/lib/server/cloudflare-provisioning.ts";
import { runCloudflareMigrations } from "../src/lib/server/cloudflare-migrations.ts";

const fixture = () => {
  const database = new DatabaseSync(":memory:");
  let loseResponse = false;
  const writes: string[] = [];

  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).pathname).toContain("/d1/database/fixture/query");
    const { sql } = z.object({ sql: z.string() }).parse(await request.json());

    if (sql.startsWith("SELECT"))
      return Response.json({
        success: true,
        result: [{ success: true, results: database.prepare(sql).all() }],
      });
    writes.push(sql);
    database.exec("BEGIN");

    try {
      database.exec(sql);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    if (loseResponse) {
      loseResponse = false;
      throw new Error("Lost query response");
    }

    return Response.json({ success: true, result: [{ success: true, results: [] }] });
  };

  const provisioner = createCloudflareProvisioner(
    { accountId: "fixture", token: "fixture", runtimeName: "fixture" },
    transport,
  );

  return {
    database,
    writes,
    run: (input: z.infer<typeof migrationRequest>) =>
      runCloudflareMigrations(provisioner, "fixture", input),
    loseResponse: () => {
      loseResponse = true;
    },
  };
};

const request = (files: { name: string; sql: string }[]) =>
  migrationRequest.parse({
    action: "apply",
    database: "DB",
    databaseId: "data",
    table: "d1_migrations",
    files,
  });

describe("Hosted D1 migrations", () => {
  it("orders numeric versions, preserves trailing comments and only applies each file once", async () => {
    const cloud = fixture();

    try {
      const input = request([
        {
          name: "10_insert.sql",
          sql: "INSERT INTO records VALUES ('second'); -- trailing comment",
        },
        {
          name: "2_create.sql",
          sql: "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('first');",
        },
      ]);

      const expected = [
        { name: "2_create.sql", applied: true },
        { name: "10_insert.sql", applied: true },
      ];

      expect(await cloud.run(input)).toEqual(expected);
      expect(await cloud.run(input)).toEqual(expected);
      expect(cloud.writes).toHaveLength(2);
      expect(cloud.database.prepare("SELECT value FROM records").all()).toEqual([
        { value: "first" },
        { value: "second" },
      ]);
    } finally {
      cloud.database.close();
    }
  });
  it("recovers a committed migration after losing its response", async () => {
    const cloud = fixture();

    try {
      const input = request([
        {
          name: "1_create.sql",
          sql: "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('once');",
        },
      ]);

      cloud.loseResponse();
      await expect(cloud.run(input)).rejects.toThrow("connection error");
      expect(await cloud.run(input)).toEqual([{ name: "1_create.sql", applied: true }]);
      expect(cloud.writes).toHaveLength(1);
      expect(cloud.database.prepare("SELECT COUNT(*) AS count FROM records").get()).toEqual({
        count: 1,
      });
    } finally {
      cloud.database.close();
    }
  });
  it("rolls back SQL and history together, keeping earlier successful files", async () => {
    const cloud = fixture();

    try {
      await expect(
        cloud.run(
          request([
            { name: "1_create.sql", sql: "CREATE TABLE records(value TEXT);" },
            {
              name: "2_fail.sql",
              sql: "INSERT INTO records VALUES ('rolled back'); INSERT INTO missing VALUES (1);",
            },
          ]),
        ),
      ).rejects.toThrow();
      expect(cloud.database.prepare("SELECT * FROM records").all()).toEqual([]);
      expect(cloud.database.prepare("SELECT name FROM d1_migrations").all()).toEqual([
        { name: "1_create.sql" },
      ]);
      expect(
        await cloud.run(
          request([{ name: "2_fail.sql", sql: "INSERT INTO records VALUES ('fixed');" }]),
        ),
      ).toEqual([{ name: "2_fail.sql", applied: true }]);
    } finally {
      cloud.database.close();
    }
  });
  it("fences concurrent attempts before either can apply the same SQL twice", async () => {
    const cloud = fixture();

    try {
      const input = request([
        {
          name: "1_create.sql",
          sql: "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('once');",
        },
      ]);

      const attempts = await Promise.allSettled([cloud.run(input), cloud.run(input)]);
      expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(true);
      expect(await cloud.run(input)).toEqual([{ name: "1_create.sql", applied: true }]);
      expect(cloud.database.prepare("SELECT COUNT(*) AS count FROM records").get()).toEqual({
        count: 1,
      });
    } finally {
      cloud.database.close();
    }
  });

  it("lists pending migrations without creating a history table", async () => {
    const cloud = fixture();

    try {
      const input = migrationRequest.parse({
        ...request([]),
        action: "list",
        files: [{ name: "1_create.sql" }],
      });

      expect(await cloud.run(input)).toEqual([{ name: "1_create.sql", applied: false }]);
      expect(cloud.writes).toEqual([]);
      expect(cloud.database.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
    } finally {
      cloud.database.close();
    }
  });
});
