import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

describe("Job secret revisions migration", () => {
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

      if (file === "0043_job_secret_revisions.sql") {
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

  it("removes stored secret values from jobs and keeps their revisions", async () => {
    const appId = "00000000-0000-4000-8000-000000000001";
    await client.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ('tenant', 'Tenant', 'tenant', now())`,
    );
    await client.query(
      `INSERT INTO app (id, organization_id, owner_id, slug, display_name, hostname, secrets, secret_revision)
        VALUES ($1, 'tenant', 'owner', 'secrets', 'Secrets', 'secrets.example.test',
          '{"SYNTHETIC_TOKEN": "synthetic-ciphertext"}'::jsonb, 2)`,
      [appId],
    );
    await client.query(
      `INSERT INTO job (id, app_id, organization_id, kind, app_secrets) VALUES
        ('00000000-0000-4000-8000-000000000011', $1, 'tenant', 'deploy', $2::jsonb),
        ('00000000-0000-4000-8000-000000000012', $1, 'tenant', 'deploy', $3::jsonb),
        ('00000000-0000-4000-8000-000000000013', $1, 'tenant', 'deploy', NULL),
        ('00000000-0000-4000-8000-000000000014', NULL, 'tenant', 'runtime', NULL)`,
      [
        appId,
        JSON.stringify({
          appId,
          revision: 1,
          values: { SYNTHETIC_TOKEN: "synthetic-ciphertext" },
        }),
        JSON.stringify({ appId, revision: 2 }),
      ],
    );
    await client.query(migration);

    const jobs = await client.query<{ id: string; app_secrets: unknown }>(
      `SELECT id, app_secrets FROM job ORDER BY id`,
    );

    expect(jobs.rows).toEqual([
      { id: "00000000-0000-4000-8000-000000000011", app_secrets: { appId, revision: 1 } },
      { id: "00000000-0000-4000-8000-000000000012", app_secrets: { appId, revision: 2 } },
      { id: "00000000-0000-4000-8000-000000000013", app_secrets: null },
      { id: "00000000-0000-4000-8000-000000000014", app_secrets: null },
    ]);

    const apps = await client.query<{ secrets: unknown; secret_revision: number }>(
      `SELECT secrets, secret_revision FROM app`,
    );

    expect(apps.rows).toEqual([
      { secrets: { SYNTHETIC_TOKEN: "synthetic-ciphertext" }, secret_revision: 2 },
    ]);
  });
});
