import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { z } from "zod";

const directory = new URL("../migrations/", import.meta.url);

describe("Open app connections migration", () => {
  let client: pg.Client;
  let admin: pg.Client;
  let databaseName: string;
  let migration: string;

  beforeEach(async () => {
    const connectionString =
      "postgres://platform_test:local-test-only@127.0.0.1:25432/platform_test";

    admin = new pg.Client({ connectionString });
    await admin.connect();
    databaseName = `migration_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const address = new URL(connectionString);
    address.pathname = `/${databaseName}`;
    client = new pg.Client({ connectionString: address.toString() });
    await client.connect();
    await client.query("BEGIN");

    for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
      const source = await readFile(new URL(file, directory), "utf8");

      if (file === "0042_open_app_connections.sql") {
        migration = source;
        break;
      }

      await client.query(source);
    }
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  it("removes connection requests and API availability while keeping apps", async () => {
    await client.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ('tenant', 'Tenant', 'tenant', now())`,
    );
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ('requester', 'Requester', 'requester@example.test', true, now(), now())`,
    );
    const [caller, provider] = [crypto.randomUUID(), crypto.randomUUID()];

    for (const [id, slug] of [
      [caller, "caller"],
      [provider, "provider"],
    ] as const)
      await client.query(
        `INSERT INTO app (id, slug, display_name, organization_id, owner_id, hostname, service_access_mode)
          VALUES ($1, $2, $2, 'tenant', 'requester', $2 || '.apps.example.test', 'organization')`,
        [id, slug],
      );
    await client.query(
      `INSERT INTO connection_request (id, organization_id, app_id, service_id, binding, entrypoint, requester_id)
        VALUES ($1, 'tenant', $2, $3, 'ERP', 'default', 'requester')`,
      [crypto.randomUUID(), caller, provider],
    );

    await client.query(migration);

    const table = await client.query("SELECT to_regclass('connection_request') AS name");
    expect(table.rows).toEqual([{ name: null }]);

    const column = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'app' AND column_name = 'service_access_mode'`,
    );

    expect(column.rows).toEqual([]);

    const remaining = await client.query("SELECT slug FROM app ORDER BY slug");
    expect(remaining.rows).toEqual([{ slug: "caller" }, { slug: "provider" }]);
  });

  it("registers every migration file in the journal that installations apply", async () => {
    const journal = z
      .object({ entries: z.array(z.object({ tag: z.string() })) })
      .parse(JSON.parse(await readFile(new URL("meta/_journal.json", directory), "utf8")));

    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .map((file) => file.slice(0, -".sql".length))
      .sort();

    expect(journal.entries.map((entry) => entry.tag)).toEqual(files);
  });
});
