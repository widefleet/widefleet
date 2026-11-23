import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

describe("App connector migration", () => {
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

      if (file === "0039_app_connector.sql") {
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

  it("marks apps that offer personal connections as personal connectors", async () => {
    await client.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ('tenant', 'Tenant', 'tenant', now())`,
    );

    // The entrypoints of each app's active deployment; the last app has only an inactive one.
    const fixtures = [
      { slug: "mail", entrypoints: ["default", "UserConnection"], active: true },
      { slug: "notes", entrypoints: ["default"], active: true },
      { slug: "draft", entrypoints: ["UserConnection"], active: false },
    ];

    for (const { slug, entrypoints, active } of fixtures) {
      const {
        rows: [app],
      } = await client.query<{ id: string }>(
        `INSERT INTO app (id, organization_id, slug, display_name, owner_id, hostname)
          VALUES (gen_random_uuid(), 'tenant', $1, $1, 'owner', $1 || '.apps.example.test')
          RETURNING id`,
        [slug],
      );

      const {
        rows: [artifact],
      } = await client.query<{ id: string }>(
        `INSERT INTO artifact (id, app_id, metadata, manifest, modules)
          VALUES (gen_random_uuid(), $1, $2, '{}', '[]') RETURNING id`,
        [app?.id, JSON.stringify({ entrypoints })],
      );

      const {
        rows: [deployment],
      } = await client.query<{ id: string }>(
        `INSERT INTO deployment (id, app_id, artifact_id, status, request_id)
          VALUES (gen_random_uuid(), $1, $2, 'succeeded', 'request') RETURNING id`,
        [app?.id, artifact?.id],
      );

      if (active)
        await client.query(`UPDATE app SET active_deployment_id = $1 WHERE id = $2`, [
          deployment?.id,
          app?.id,
        ]);
    }

    await client.query(migration);

    const result = await client.query<{ slug: string; connector: string | null }>(
      `SELECT slug, connector FROM app ORDER BY slug`,
    );

    expect(result.rows).toEqual([
      { slug: "draft", connector: null },
      { slug: "mail", connector: "personal" },
      { slug: "notes", connector: null },
    ]);
  });
});
