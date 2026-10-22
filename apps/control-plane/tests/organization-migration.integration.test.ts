import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

describe("Organization ownership migration", () => {
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

      if (file === "0021_organization_ownership.sql") {
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

  it("assigns resources directly to their organization and removes the fleet identity", async () => {
    await client.query(`
      INSERT INTO organization (id, name, slug, created_at)
        VALUES ('second-org', 'Second', 'second', now());
      INSERT INTO fleet (name, organization_id, executor, app_hostname_suffix)
        VALUES ('second', 'second-org', 'cloudflare', 'second');
      INSERT INTO agent (id, name, token_hash, fleet_id)
        SELECT gen_random_uuid(), name, name, id FROM fleet;
      INSERT INTO app (id, slug, display_name, owner_id, hostname, fleet_id)
        SELECT gen_random_uuid(), 'notes', 'Notes', 'synthetic-owner', name || '.example.test', id FROM fleet;
    `);
    await client.query(migration);

    for (const table of ["app", "agent", "organization_runtime"]) {
      const result = await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM ${table} ORDER BY organization_id`,
      );

      expect(result.rows).toEqual([
        { organization_id: "second-org" },
        { organization_id: "widefleet" },
      ]);
    }

    const runtimes = await client.query<{ executor: string; app_hostname_suffix: string | null }>(
      "SELECT executor, app_hostname_suffix FROM organization_runtime ORDER BY organization_id",
    );

    expect(runtimes.rows).toEqual([
      { executor: "cloudflare", app_hostname_suffix: "second" },
      { executor: "agent", app_hostname_suffix: null },
    ]);

    const removed = await client.query<{ name: string | null }>(
      "SELECT to_regclass('fleet') AS name",
    );

    expect(removed.rows).toEqual([{ name: null }]);
    await expect(
      client.query("INSERT INTO organization_runtime (organization_id) VALUES ('widefleet')"),
    ).rejects.toThrow("organization_runtime_pkey");
  });

  it("rejects ambiguous execution ownership without merging separate environments", async () => {
    await client.query("INSERT INTO fleet (name, organization_id) VALUES ('extra', 'widefleet')");
    await expect(client.query(migration)).rejects.toThrow("organization_runtime_pkey");
  });

  it("preserves existing runtime configuration, jobs and connectors", async () => {
    await client.query(`
      UPDATE fleet SET runtime = '{"version":"synthetic"}', applied_runtime = '{"version":"previous"}';
      INSERT INTO job (id, fleet_id, kind, state)
        SELECT gen_random_uuid(), id, 'connector', 'queued' FROM fleet;
      INSERT INTO connector (fleet_id, name, package, applied_package, job_id)
        SELECT fleet_id, 'synthetic', '{"checksum":"fixture"}', '{"checksum":"previous"}', id FROM job;
      INSERT INTO cloudflare_operation (id, fleet_id, command, targets, result, created_at)
        SELECT gen_random_uuid(), id, jsonb_build_object(
          'kind', 'connector', 'fleetId', id,
          'actor', jsonb_build_object('application', jsonb_build_object(
            'fleetId', id, 'organizationId', organization_id, 'admin', true
          ))
        ), '[]', '{}', now() FROM fleet;
    `);
    await client.query(migration);

    const result = await client.query<{
      runtime: { version: string };
      applied_runtime: { version: string };
    }>("SELECT runtime, applied_runtime FROM organization_runtime");

    expect(result.rows).toEqual([
      { runtime: { version: "synthetic" }, applied_runtime: { version: "previous" } },
    ]);

    for (const table of ["job", "connector", "cloudflare_operation"]) {
      const rows = await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM ${table}`,
      );

      expect(rows.rows).toEqual([{ organization_id: "widefleet" }]);
    }

    const connector = await client.query<{ package: { checksum: string } }>(
      "SELECT package FROM connector",
    );

    expect(connector.rows).toEqual([{ package: { checksum: "fixture" } }]);

    const operation = await client.query<{ command: unknown }>(
      "SELECT command FROM cloudflare_operation",
    );

    expect(operation.rows).toEqual([
      {
        command: {
          kind: "connector",
          organizationId: "widefleet",
          actor: { application: { organizationId: "widefleet", admin: true } },
        },
      },
    ]);
  });

  it("moves existing login settings and encrypted secrets into the installation organization", async () => {
    await client.query(migration);
    await client.query(`
      INSERT INTO "user" (id, name, email) VALUES ('owner', 'Owner', 'owner@example.test');
      INSERT INTO installation (id, settings, owner_id, local_password_enabled)
        VALUES ('widefleet', '{"externallyManaged":true,"identity":{"management":{"secret":{"type":"stored","id":"secret"}}}}', 'owner', false);
      INSERT INTO installation_secret (id, ciphertext) VALUES ('secret', 'opaque-existing-ciphertext');
    `);
    await client.query(
      await readFile(
        new URL("../migrations/0022_organization_settings.sql", import.meta.url),
        "utf8",
      ),
    );

    const settings = await client.query<{ organization_id: string; settings: unknown }>(
      "SELECT organization_id, settings FROM organization_settings",
    );

    expect(settings.rows).toEqual([
      {
        organization_id: "widefleet",
        settings: {
          externallyManaged: true,
          identity: { management: { secret: { type: "stored", id: "secret" } } },
        },
      },
    ]);

    const secrets = await client.query<{ id: string; organization_id: string; ciphertext: string }>(
      "SELECT id, organization_id, ciphertext FROM organization_secret",
    );

    expect(secrets.rows).toEqual([
      { id: "secret", organization_id: "widefleet", ciphertext: "opaque-existing-ciphertext" },
    ]);

    const state = await client.query<{ owner_id: string; local_password_enabled: boolean }>(
      "SELECT owner_id, local_password_enabled FROM installation",
    );

    expect(state.rows).toEqual([{ owner_id: "owner", local_password_enabled: false }]);
  });
});
