import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { organizationSettings } from "../src/lib/server/schema.ts";
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
    const encryption = environment.encryption;
    await database.delete(ssoProvider);
    const directory = { clientId: "directory-client" };
    await database
      .update(organizationSettings)
      .set({
        directorySecret: await encryption.encrypt(
          { kind: "directory-client-secret", organizationId: "widefleet" },
          "directory-secret",
        ),
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
              secret: {
                ciphertext: await encryption.encrypt(
                  { kind: "legacy-sso-client-secret", organizationId: "widefleet" },
                  "management-secret",
                ),
              },
            },
            directory,
          },
        },
      })
      .where(eq(organizationSettings.organizationId, "widefleet"));
    await migrateSsoSettings(database, encryption);
    const provider = await readSsoConfiguration(database, encryption, "widefleet");
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
      embeddingOrigins: [],
    });
    expect(
      await encryption.decrypt(
        { kind: "directory-client-secret", organizationId: "widefleet" },
        saved?.directorySecret ?? "",
      ),
    ).toBe("directory-secret");
    await migrateSsoSettings(database, encryption);
    expect(await readSsoConfiguration(database, encryption, "widefleet")).toEqual(provider);
  },
);
