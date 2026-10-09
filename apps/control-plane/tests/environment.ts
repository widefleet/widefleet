import { createReporting } from "../src/lib/server/reporting.ts";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { createEmulator } from "emulate";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createSettingsService } from "../src/lib/server/settings.ts";
import {
  createInstallationOwner,
  initializeInstallation,
} from "../src/lib/server/installation-store.ts";
import { createAuthentication, registerCli } from "../src/lib/server/auth.ts";
import { configurationSchema } from "../src/lib/server/config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { account, member } from "../src/lib/server/auth-schema.ts";
import { enrollCompanyUser, initializeOrganization } from "../src/lib/server/organization.ts";
import { companyAccountProvider, companyIdentity } from "../src/lib/server/company-identity.ts";

export const createTestEnvironment = async (
  platformUrl = "http://localhost:25430",
  provider: "entra" | "oidc" = "entra",
) => {
  const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const clientId = "00000000-0000-4000-8000-000000000002";
  const clientSecret = "local-tests-only";

  const replacementClient = {
    tenantId: "00000000-0000-4000-8000-000000000099",
    clientId: "00000000-0000-4000-8000-000000000098",
    clientSecret,
  };

  const oidcIssuer = `http://localhost:25439/${tenantId}/v2.0`;

  const providerId =
    provider === "entra"
      ? "microsoft"
      : companyAccountProvider(
          companyIdentity.parse({
            provider: { type: "oidc", issuer: oidcIssuer, label: "Company SSO" },
            management: { clientId, clientSecret },
          }),
        );

  const emulator = await createEmulator({
    service: "microsoft",
    port: provider === "oidc" ? 25439 : 0,
    seed: {
      microsoft: {
        users: [
          { email: "sso@example.test", name: "SSO Test User", tenant_id: tenantId },
          {
            email: "foreign@example.test",
            name: "Foreign Tenant User",
            tenant_id: replacementClient.tenantId,
          },
        ],
        oauth_clients: [
          {
            client_id: replacementClient.clientId,
            client_secret: replacementClient.clientSecret,
            name: "Replacement tenant fixture",
            tenant_id: replacementClient.tenantId,
            redirect_uris: [`${platformUrl}/api/auth/callback/microsoft`],
          },
          {
            client_id: clientId,
            client_secret: clientSecret,
            name: "Management fixture",
            tenant_id: tenantId,
            redirect_uris: [`${platformUrl}/api/auth/callback/${providerId}`],
          },
        ],
      },
    },
  });

  const admin = new pg.Pool({
    connectionString: "postgres://platform_test:local-test-only@127.0.0.1:25432/platform_test",
  });

  // The identifier contains only a fixed prefix and hexadecimal UUID characters.
  await admin.query(`CREATE DATABASE "${name}"`);

  const directory = await mkdtemp(join(tmpdir(), "widefleet-test-"));
  const ownerSubject = "00000000-0000-4000-8000-000000000003";

  const environment = {
    PLATFORM_USAGE_REPORTING: "false",
    PLATFORM_CRASH_REPORTING: "false",
    PLATFORM_STATE_DIRECTORY: directory,
    PLATFORM_AUTH_DIRECTORY: join(directory, "auth"),
    PLATFORM_ENCRYPTION_KEY: "local-integration-test-encryption-key-only",
    DATABASE_URL: `postgres://platform_test:local-test-only@127.0.0.1:25432/${name}`,
    PLATFORM_URL: platformUrl,
    APP_DOMAIN: "apps.localhost",
    S3_ENDPOINT: "http://localhost:25400",
    S3_BUCKET: "artifacts",
    S3_ACCESS_KEY_ID: "local-tests",
    S3_SECRET_ACCESS_KEY: "local-tests-only",
    BETTER_AUTH_SECRET: "local-integration-test-secret-never-deploy",
    ENTRA_AUTHORITY: emulator.url,
    ENTRA_TENANT_ID: tenantId,
    ENTRA_CLIENT_ID: clientId,
    ENTRA_CLIENT_SECRET: clientSecret,
    ADMIN_ENTRA_OBJECT_IDS: "00000000-0000-4000-8000-000000000003",
    ...(provider === "oidc"
      ? {
          SSO_PROVIDER: "oidc",
          OIDC_ISSUER: oidcIssuer,
          OIDC_LABEL: "Company SSO",
          OIDC_CLIENT_ID: clientId,
          OIDC_CLIENT_SECRET: clientSecret,
          ADMIN_OIDC_SUBJECTS: "initial-owner",
        }
      : { SSO_PROVIDER: "entra" }),
  };

  const identity = companyIdentity.parse({
    provider:
      provider === "entra"
        ? { type: "entra", tenantId, authority: emulator.url, label: "Microsoft" }
        : { type: "oidc", issuer: oidcIssuer, label: "Company SSO" },
    management: { clientId, clientSecret },
  });

  const configuration = {
    ...configurationSchema.parse(environment),
    IDENTITY: identity,
    BETTER_AUTH_SECRET: environment.BETTER_AUTH_SECRET,
  };

  if (configuration.ARTIFACT_STORAGE_PROVIDER !== "s3")
    throw new Error("Expected the S3 test fixture");
  const database = createDatabase(configuration);

  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });

  const auth = createAuthentication(configuration, database.db);

  await initializeOrganization(database.db);
  await initializeInstallation(database.db);

  const settings = createSettingsService(
    configuration,
    database.db,
    environment.PLATFORM_ENCRYPTION_KEY,
    Buffer.alloc(32, 1).toString("base64url"),
  );

  await settings.initialize({
    externallyManaged: false,
    identity: {
      provider: identity.provider,
      management: { clientId, secret: { type: "value", value: clientSecret } },
      apps: { clientId, secret: { type: "value", value: clientSecret } },
      directory: null,
    },
  });

  const owner = await createInstallationOwner(database.db, {
    name: "Setup Owner",
    email: "owner@example.test",
    password: "local-test-password-only",
  });

  await registerCli(auth, database.db, configuration);

  // The exported fixture factory accepts Better Auth's general plugin context.
  const fixtureAuth = betterAuth<BetterAuthOptions>(auth.options);
  const helpers = testUtils().init(await fixtureAuth.$context).context.test;

  return {
    configuration,
    reporting: createReporting(configuration, database.db),
    replacementClient,
    settings,
    owner,
    ownerSubject,
    environment,
    database,
    auth,
    users: helpers,
    linkMicrosoftUser: async (userId: string, objectId: string = crypto.randomUUID()) => {
      await database.db.insert(account).values({
        id: crypto.randomUUID(),
        providerId: "microsoft",
        accountId: objectId,
        userId,
      });
      await enrollCompanyUser(database.db, userId);

      if (objectId === ownerSubject)
        await database.db.update(member).set({ role: "owner" }).where(eq(member.userId, userId));
    },
    close: async () => {
      await emulator.close();
      await database.close();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
};
