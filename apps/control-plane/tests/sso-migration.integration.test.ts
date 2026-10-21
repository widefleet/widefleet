import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { organizationSettings, organizationSecrets } from "../src/lib/server/schema.ts";
import { encryptSecret, decryptSecret } from "../src/lib/server/secret-encryption.ts";
import { migrateSsoSettings } from "../src/lib/server/sso-migration.ts";
import { readSsoConfiguration } from "../src/lib/server/sso-settings.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

it("moves legacy SSO once, keeps directory credentials and requires explicit domain proof", async () => {
  const database = environment.database.db;
  const key = environment.environment.PLATFORM_ENCRYPTION_KEY;
  await database.delete(ssoProvider);
  const managementId = crypto.randomUUID();
  const appsId = crypto.randomUUID();
  const directoryId = crypto.randomUUID();

  for (const [id, value] of [
    [managementId, "management-secret"],
    [appsId, "old-app-secret"],
    [directoryId, "directory-secret"],
  ]) {
    if (!id || !value) throw new Error("Missing fixture credential");
    await database
      .insert(organizationSecrets)
      .values({ id, organizationId: "widefleet", ciphertext: await encryptSecret(key, value) });
  }

  const directory = { clientId: "directory-client", secret: { type: "stored", id: directoryId } };
  await database
    .update(organizationSettings)
    .set({
      settings: {
        externallyManaged: true,
        identity: {
          provider: environment.configuration.IDENTITY.provider,
          management: { clientId: "company-client", secret: { type: "stored", id: managementId } },
          apps: { clientId: "old-app-client", secret: { type: "stored", id: appsId } },
          directory,
        },
      },
    })
    .where(eq(organizationSettings.organizationId, "widefleet"));
  await migrateSsoSettings(database, key);
  const provider = await readSsoConfiguration(database, key, "widefleet");
  expect(provider).toMatchObject({
    providerId: "microsoft",
    domain: "",
    domainVerified: false,
    oidcConfig: { clientId: "company-client", clientSecret: "management-secret" },
  });
  const [saved] = await database.select().from(organizationSettings);
  expect(saved?.settings).toEqual({
    externallyManaged: true,
    appIdentity: { type: "entra" },
    directory,
  });
  const secrets = await database.select().from(organizationSecrets);
  expect(secrets).toHaveLength(1);
  expect(secrets[0]?.id).toBe(directoryId);
  expect(await decryptSecret(key, secrets[0]?.ciphertext ?? "")).toBe("directory-secret");
  await migrateSsoSettings(database, key);
  expect(await readSsoConfiguration(database, key, "widefleet")).toEqual(provider);
});
