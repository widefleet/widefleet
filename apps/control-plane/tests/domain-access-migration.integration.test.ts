import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

describe("Organization domain access migration", () => {
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

      if (file === "0038_organization_domain_access.sql") {
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

  it("keeps existing organizations closed to domain joining and unrestricted", async () => {
    await client.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ('tenant', 'Tenant', 'tenant', now())`,
    );
    await client.query(
      `INSERT INTO organization_settings (organization_id, settings, sso_required)
        VALUES ('tenant', '{}'::jsonb, true)`,
    );
    await client.query(migration);

    const result = await client.query<{
      organization_id: string;
      join_domains: unknown;
      restrict_organization_creation: boolean;
      sso_required: boolean;
    }>(
      `SELECT organization_id, join_domains, restrict_organization_creation, sso_required
        FROM organization_settings ORDER BY organization_id`,
    );

    expect(result.rows).toEqual([
      {
        organization_id: "tenant",
        join_domains: [],
        restrict_organization_creation: false,
        sso_required: true,
      },
    ]);
  });
});
