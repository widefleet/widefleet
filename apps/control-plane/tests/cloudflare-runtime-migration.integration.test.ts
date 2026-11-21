import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

describe("Cloudflare installation runtime migration", () => {
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
    const directory = new URL("../migrations/", import.meta.url);

    for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
      const source = await readFile(new URL(file, directory), "utf8");

      if (file === "0036_cloudflare_installation_runtime.sql") {
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

  it("clears organization runtimes on Cloudflare and keeps the installation and agent selections", async () => {
    const installation = { version: "0.7.20", checksum: "a".repeat(64) };
    const stale = { version: "0.3.0", checksum: "b".repeat(64) };

    const updated = await client.query(
      `UPDATE organization_runtime
        SET executor = 'cloudflare', runtime = $1, applied_runtime = $1
        WHERE organization_id = 'widefleet'`,
      [installation],
    );

    expect(updated.rowCount).toBe(1);
    await client.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES
        ('tenant', 'Tenant', 'tenant', now()),
        ('agent-org', 'Agent', 'agent', now())`,
    );
    await client.query(
      `INSERT INTO organization_runtime
        (organization_id, executor, app_hostname_suffix, runtime, applied_runtime)
        VALUES ('tenant', 'cloudflare', 'tenant', $1, NULL),
               ('agent-org', 'agent', 'agent', $1, $1)`,
      [stale],
    );
    await client.query(migration);

    const result = await client.query<{
      organization_id: string;
      runtime: unknown;
      applied_runtime: unknown;
    }>(
      "SELECT organization_id, runtime, applied_runtime FROM organization_runtime ORDER BY organization_id",
    );

    expect(result.rows).toEqual([
      { organization_id: "agent-org", runtime: stale, applied_runtime: stale },
      { organization_id: "tenant", runtime: null, applied_runtime: null },
      { organization_id: "widefleet", runtime: installation, applied_runtime: installation },
    ]);
  });
});
