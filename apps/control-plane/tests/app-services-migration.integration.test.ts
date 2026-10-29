import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

let admin: pg.Client;

let client: pg.Client;

let databaseName: string;

let migration: string;

beforeAll(async () => {
  const connectionString = "postgres://platform_test:local-test-only@127.0.0.1:25432/platform_test";
  admin = new pg.Client({ connectionString });
  await admin.connect();
  databaseName = `migration_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const address = new URL(connectionString);
  address.pathname = `/${databaseName}`;
  client = new pg.Client({ connectionString: address.toString() });
  await client.connect();
  const directory = new URL("../migrations/", import.meta.url);

  for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
    const source = await readFile(new URL(file, directory), "utf8");

    if (file === "0028_app_services.sql") {
      migration = source;
      break;
    }

    await client.query(source);
  }
});

afterAll(async () => {
  await client.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
});

it("removes legacy connector state while preserving apps and unrelated deployments", async () => {
  await client.query(`
    INSERT INTO app (id, organization_id, slug, display_name, owner_id, hostname,
      capabilities, capability_revision, applied_capabilities, applied_capability_revision)
    VALUES ('00000000-0000-4000-8000-000000000001', 'widefleet', 'mail-reader', 'Mail reader',
      'synthetic-owner', 'mail-reader.example.test',
      '{"MAIL":{"connector":"mail","entrypoint":"default"}}', 7,
      '{"revision":7,"grants":{"MAIL":{"connector":"mail","entrypoint":"default"}}}', 7);
    INSERT INTO job (id, organization_id, kind, state, connector)
    VALUES ('00000000-0000-4000-8000-000000000002', 'widefleet', 'connector', 'queued', '{"name":"mail"}');
    INSERT INTO connector (organization_id, name, package, job_id)
    VALUES ('widefleet', 'mail', '{"secrets":{"TOKEN":"synthetic-ciphertext"}}',
      '00000000-0000-4000-8000-000000000002');
    INSERT INTO job (id, organization_id, app_id, kind, state, capabilities)
    SELECT gen_random_uuid(), organization_id, id, 'configure', 'queued', applied_capabilities FROM app;
    INSERT INTO cloudflare_operation (id, app_id, command, targets, result, created_at)
    SELECT gen_random_uuid(), id, jsonb_build_object('kind', kind), '[]', '{}', now()
      FROM app CROSS JOIN (VALUES ('capabilities'), ('deploy')) AS commands(kind);
    INSERT INTO cloudflare_operation (id, organization_id, command, targets, result, created_at)
    VALUES (gen_random_uuid(), 'widefleet', '{"kind":"connector"}', '[]', '{}', now());
  `);
  await client.query(migration);
  const tables = await client.query("SELECT to_regclass('connector') AS connector");
  expect(tables.rows).toEqual([{ connector: null }]);

  const columns = await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'job' AND column_name IN ('connector', 'connectors')`);

  expect(columns.rows).toEqual([]);

  const apps = await client.query(`SELECT slug, capabilities, capability_revision,
    applied_capabilities, applied_capability_revision, secrets, secret_revision, web_enabled FROM app`);

  expect(apps.rows).toEqual([
    {
      slug: "mail-reader",
      capabilities: {},
      capability_revision: 8,
      applied_capabilities: null,
      applied_capability_revision: null,
      secrets: {},
      secret_revision: 0,
      web_enabled: true,
    },
  ]);
  const jobs = await client.query("SELECT kind, capabilities FROM job");
  expect(jobs.rows).toEqual([{ kind: "configure", capabilities: null }]);

  const operations = await client.query(
    "SELECT command->>'kind' AS kind FROM cloudflare_operation",
  );

  expect(operations.rows).toEqual([{ kind: "deploy" }]);
});
