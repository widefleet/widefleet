import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { authControlPath } from "@platform/auth-proxy/publication";
import { appLoginClientId, readAppLogin } from "../../src/lib/server/app-login-client.ts";
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

  let database: ReturnType<typeof createDatabase>;
  let directory: string;
  let bootstrapPath: string;

  const initialize = (
    bootstrapFile?: string,
    configPath?: string,
    overrides: NodeJS.ProcessEnv = {},
  ) =>
    execute(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("../analytics-preload.fixture.ts", import.meta.url)),
        "tools/initialize-cloudflare.ts",
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: {
          ...process.env,
          ...environment,
          PLATFORM_BOOTSTRAP_FILE: bootstrapFile,
          WIDEFLEET_INITIALIZE_CONFIG: configPath,
          APP_COOKIE_SECRET: undefined,
          WIDEFLEET_RUNTIME_EXTENSION: undefined,
          ...overrides,
        },
        timeout: 15_000,
      },
    );

  beforeEach(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    database = createDatabase(cloudflareConfigurationSchema.parse(environment));
    directory = await mkdtemp(join(tmpdir(), "widefleet-hosted-init-"));
    bootstrapPath = join(directory, "bootstrap.json");
    await writeFile(
      bootstrapPath,
      JSON.stringify({
        owner: {
          name: "Hosted Owner",
          email: "owner@example.test",
        },
      }),
    );
  });
  afterEach(async () => {
    await database.close();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);

    if (directory) await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await admin.end();
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
    expect((await initialize(bootstrapPath)).stdout).toContain("Hosted installation initialized");
    const installed = await readInstallation(database.db);
    expect(installed.ownerId).toEqual(expect.any(String));
    const accounts = await database.db.select().from(account);
    expect(accounts).toHaveLength(0);
    await writeFile(
      bootstrapPath,
      JSON.stringify({
        owner: {
          name: "Replacement",
          email: "other@example.test",
        },
      }),
    );
    await initialize(bootstrapPath);
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

  it("observes the first hosted administrator once and flushes before exiting", async () => {
    const eventsPath = join(directory, "events.json");

    const overrides = {
      POSTHOG_PROJECT_TOKEN: "phc_synthetic",
      POSTHOG_ORIGIN: environment.PLATFORM_URL,
      TEST_ANALYTICS_OUTPUT: eventsPath,
    };

    await initialize(bootstrapPath, undefined, overrides);
    const { ownerId } = await readInstallation(database.db);
    const expected = `${JSON.stringify({ event: "user_created", distinct_id: `user:${ownerId}` })}\n`;
    expect(await readFile(eventsPath, "utf8")).toBe(expected);
    await initialize(bootstrapPath, undefined, overrides);
    expect(await readFile(eventsPath, "utf8")).toBe(expected);
  }, 30_000);

  it("requires app sign-in credentials for an email-enabled owner-only bootstrap", async () => {
    const configPath = join(directory, "initialize.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "synthetic-initialization",
        compatibility_date: "2026-10-01",
        send_email: [{ name: "EMAIL" }],
        vars: { EMAIL_FROM: "notifications@example.test" },
      }),
    );
    await expect(initialize(bootstrapPath, configPath)).rejects.toThrow("APP_COOKIE_SECRET");
    expect((await readInstallation(database.db)).ownerId).toBeNull();
  });

  it("supplies validated extension bindings from configuration and a secrets file on first initialization", async () => {
    const configPath = join(directory, "initialize.json");

    const secretsPath = join(directory, "secrets.json");

    await writeFile(
      configPath,
      JSON.stringify({
        name: "synthetic-initialization",
        compatibility_date: "2026-10-01",
        vars: { FIXTURE_EXTENSION_MODE: "enabled" },
      }),
    );
    await writeFile(
      secretsPath,
      JSON.stringify({
        FIXTURE_EXTENSION_SECRET: "synthetic-extension-secret",
      }),
      { mode: 0o600 },
    );

    const result = await initialize(bootstrapPath, configPath, {
      WIDEFLEET_RUNTIME_EXTENSION: fileURLToPath(
        new URL("./bindings-extension.fixture.ts", import.meta.url),
      ),
      WIDEFLEET_INITIALIZE_SECRETS_FILE: secretsPath,
      FIXTURE_EXTENSION_SECRET: undefined,
      FIXTURE_EXTENSION_MODE: undefined,
    });

    expect(result.stdout).toContain("Hosted installation initialized");
    expect(result.stdout + result.stderr).not.toContain("synthetic-extension-secret");
    expect((await readInstallation(database.db)).ownerId).toEqual(expect.any(String));
  });

  const emailExtension = fileURLToPath(new URL("./email-extension.fixture.ts", import.meta.url));

  it("requires app sign-in credentials when only the extension supplies email", async () => {
    await expect(
      initialize(bootstrapPath, undefined, { WIDEFLEET_RUNTIME_EXTENSION: emailExtension }),
    ).rejects.toThrow("APP_COOKIE_SECRET");
    expect((await readInstallation(database.db)).ownerId).toBeNull();
  });

  it.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")(
    "publishes default app sign-in when only the extension supplies email",
    async () => {
      const { unstable_dev } = await import("wrangler");
      const workerName = `initialize-${name}`;
      const entry = join(directory, "runtime.ts");
      await writeFile(
        entry,
        `import { manageAuthConfiguration } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@platform/auth-proxy/worker")))};
        export default { fetch: manageAuthConfiguration };`,
      );
      const runtimePath = join(directory, "runtime.json");
      await writeFile(
        runtimePath,
        JSON.stringify({
          name: workerName,
          main: entry,
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          kv_namespaces: [{ binding: "AUTH_CONFIG", id: "auth-config" }],
          vars: { WIDEFLEET_CONTROL_TOKEN: "local-initialization-control-key-never-deploy" },
        }),
      );
      const configPath = join(directory, "initialize.json");
      await writeFile(
        configPath,
        JSON.stringify({
          name: `bootstrap-${name}`,
          compatibility_date: "2026-10-01",
          services: [{ binding: "APP_RUNTIME", service: workerName }],
        }),
      );

      const worker = await unstable_dev(entry, {
        config: runtimePath,
        local: true,
        persist: false,
        ip: "127.0.0.1",
        port: 0,
        inspectorPort: 0,
        logLevel: "error",
        experimental: { disableExperimentalWarning: true, watch: false },
      });

      try {
        const configurationUrl = `http://localhost${authControlPath}/organizations/widefleet/configuration`;
        expect(await (await worker.fetch(configurationUrl)).json()).toMatchObject({
          state: "waiting",
        });
        await initialize(bootstrapPath, configPath, {
          WIDEFLEET_RUNTIME_EXTENSION: emailExtension,
          APP_COOKIE_SECRET: Buffer.alloc(32, 1).toString("base64url"),
        });
        expect(await (await worker.fetch(configurationUrl)).json()).toMatchObject({
          state: "active",
        });
        expect(
          await readAppLogin(
            database.db,
            cloudflareConfigurationSchema.parse(environment),
            environment.PLATFORM_ENCRYPTION_KEY,
            "widefleet",
          ),
        ).toMatchObject({ management: { clientId: appLoginClientId("widefleet") } });
        expect(await database.db.select().from(oauthClient)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ clientId: appLoginClientId("widefleet"), disabled: false }),
          ]),
        );
      } finally {
        await worker.stop();
      }
    },
    60_000,
  );

  describe("Existing installation", () => {
    beforeEach(async () => {
      await initialize(bootstrapPath);
    });

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

    // Failure and recovery each start a CLI process with its own 15-second deadline.
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
      expect(await database.db.select().from(oauthResource)).toMatchObject([
        { accessTokenTtl: 300 },
      ]);
    }, 30_000);
  });
});
