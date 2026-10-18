import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { account, oauthClient, oauthResource, user } from "../../src/lib/server/auth-schema.ts";
import { cliScopes } from "../../src/lib/server/auth-options.ts";
import { cloudflareConfigurationSchema } from "../../src/lib/server/cloudflare-config.ts";
import { createDatabase } from "../../src/lib/server/database.ts";
import { readInstallation } from "../../src/lib/server/installation-store.ts";

const execute = promisify(execFile);

describe("Hosted installation initialization", () => {
  const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;

  const admin = new pg.Pool({
    connectionString: "postgres://platform_test:local-test-only@127.0.0.1:25432/platform_test",
  });

  const environment = {
    DATABASE_URL: `postgres://platform_test:local-test-only@127.0.0.1:25432/${name}`,
    PLATFORM_URL: "https://platform.example.test",
    APP_DOMAIN: "apps.example.test",
    BETTER_AUTH_SECRET: "local-test-only-authentication-secret",
    PLATFORM_ENCRYPTION_KEY: "local-test-only-encryption-secret",
  };

  const database = createDatabase(cloudflareConfigurationSchema.parse(environment));
  let directory: string;

  const initialize = (bootstrapFile?: string) =>
    execute(process.execPath, ["tools/initialize-cloudflare.ts"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, ...environment, PLATFORM_BOOTSTRAP_FILE: bootstrapFile },
      timeout: 15_000,
    });

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    directory = await mkdtemp(join(tmpdir(), "widefleet-hosted-init-"));
  });
  afterAll(async () => {
    await database.close();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();

    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("requires stable keys, migrates an empty database, and creates the owner only once", async () => {
    for (const key of ["BETTER_AUTH_SECRET", "PLATFORM_ENCRYPTION_KEY"]) {
      expect(
        cloudflareConfigurationSchema.safeParse({ ...environment, [key]: undefined }).success,
      ).toBe(false);
      expect(cloudflareConfigurationSchema.safeParse({ ...environment, [key]: "" }).success).toBe(
        false,
      );
    }

    await expect(initialize()).rejects.toThrow(
      "PLATFORM_BOOTSTRAP_FILE must provide the first hosted administrator",
    );
    expect((await readInstallation(database.db)).ownerId).toBeNull();
    const path = join(directory, "bootstrap.json");
    await writeFile(
      path,
      JSON.stringify({
        owner: {
          name: "Hosted Owner",
          email: "owner@example.test",
          password: "local-test-only-password",
        },
      }),
    );
    expect((await initialize(path)).stdout).toContain("Hosted installation initialized");
    const installed = await readInstallation(database.db);
    expect(installed.ownerId).toEqual(expect.any(String));
    const accounts = await database.db.select().from(account);
    expect(accounts).toHaveLength(1);
    await writeFile(
      path,
      JSON.stringify({
        owner: {
          name: "Replacement",
          email: "other@example.test",
          password: "a-different-local-test-password",
        },
      }),
    );
    await initialize(path);
    await initialize();
    expect(await readInstallation(database.db)).toEqual(installed);
    expect(await database.db.select().from(account)).toEqual(accounts);
    expect(await database.db.select().from(user)).toMatchObject([
      { id: installed.ownerId, email: "owner@example.test" },
    ]);
    expect(await database.db.select().from(oauthClient)).toHaveLength(1);
    expect(await database.db.select().from(oauthResource)).toMatchObject([
      {
        identifier: `${environment.PLATFORM_URL}/api/v1`,
        allowedScopes: cliScopes,
        accessTokenTtl: 300,
        disabled: false,
      },
    ]);
  }, 30_000);

  it("updates the resource policy and CLI scopes when initialization runs for an upgrade", async () => {
    await database.db.update(oauthResource).set({
      allowedScopes: ["platform:read"],
      accessTokenTtl: 3600,
    });
    await database.db.update(oauthClient).set({ scopes: ["platform:read"] });

    expect((await initialize()).stdout).toContain("Hosted installation initialized");
    expect(await database.db.select().from(oauthResource)).toMatchObject([
      { allowedScopes: cliScopes, accessTokenTtl: 300 },
    ]);
    expect(await database.db.select().from(oauthClient)).toMatchObject([{ scopes: cliScopes }]);
  });

  it("exits unsuccessfully if the expected policy was not stored", async () => {
    await database.db.update(oauthResource).set({ accessTokenTtl: 3600 });
    await database.db.execute(sql`
      CREATE FUNCTION fixture_skip_policy_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN OLD; END;
      $$;
      CREATE TRIGGER fixture_skip_policy_update BEFORE UPDATE ON oauth_resource
        FOR EACH ROW EXECUTE FUNCTION fixture_skip_policy_update();
    `);

    try {
      const failed = initialize();
      await expect(failed).rejects.toThrow("CLI resource policy was not initialized");
      await expect(failed).rejects.toHaveProperty("code", 1);
      await expect(failed).rejects.toHaveProperty("stdout", "");
    } finally {
      await database.db.execute(sql`DROP TRIGGER fixture_skip_policy_update ON oauth_resource`);
    }

    expect((await initialize()).stdout).toContain("Hosted installation initialized");
    expect(await database.db.select().from(oauthResource)).toMatchObject([{ accessTokenTtl: 300 }]);
  });
});
