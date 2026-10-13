import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, oauthClient, user } from "../../src/lib/server/auth-schema.ts";
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
  }, 30_000);
});
