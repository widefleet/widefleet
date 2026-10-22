import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { organizationSettings } from "../src/lib/server/schema.ts";
import { encryptSecret, decryptSecret } from "../src/lib/server/secret-encryption.ts";
import { migrateSsoSettings } from "../src/lib/server/sso-migration.ts";
import { readSsoConfiguration } from "../src/lib/server/sso-settings.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

it.each(["entra", "oidc"] as const)(
  "moves legacy %s SSO once and preserves its claims and directory credentials",
  async (type) => {
    const database = environment.database.db;
    const key = environment.environment.PLATFORM_ENCRYPTION_KEY;
    await database.delete(ssoProvider);
    const directory = { clientId: "directory-client" };
    await database
      .update(organizationSettings)
      .set({
        directorySecret: await encryptSecret(key, "directory-secret"),
        settings: {
          externallyManaged: true,
          identity: {
            provider:
              type === "entra"
                ? environment.configuration.IDENTITY.provider
                : {
                    type: "oidc",
                    issuer: "https://login.example.test",
                    label: "Company",
                    nameClaim: "display_name",
                    emailClaim: "mail",
                    groupsClaim: "roles",
                  },
            management: {
              clientId: "company-client",
              secret: { ciphertext: await encryptSecret(key, "management-secret") },
            },
            directory,
          },
        },
      })
      .where(eq(organizationSettings.organizationId, "widefleet"));
    await migrateSsoSettings(database, key);
    const provider = await readSsoConfiguration(database, key, "widefleet");
    expect(provider).toMatchObject({
      domain: "",
      domainVerified: false,
      appIdentityType: type,
      oidcConfig: {
        clientId: "company-client",
        clientSecret: "management-secret",
        mapping: { extraFields: { groups: type === "entra" ? "groups" : "roles" } },
      },
    });
    const [saved] = await database.select().from(organizationSettings);
    expect(saved?.settings).toEqual({
      externallyManaged: true,
      directory,
    });
    expect(await decryptSecret(key, saved?.directorySecret ?? "")).toBe("directory-secret");
    await migrateSsoSettings(database, key);
    expect(await readSsoConfiguration(database, key, "widefleet")).toEqual(provider);
  },
);
