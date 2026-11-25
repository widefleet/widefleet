import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { apps, organizationSettings } from "../src/lib/server/schema.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { createTestEnvironment } from "./environment.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

const guard = async () =>
  environment.database.db.execute(
    sql.raw(
      await readFile(
        new URL("../migrations/0044_require_jwe_secrets.sql", import.meta.url),
        "utf8",
      ),
    ),
  );

// A JWE compact serialization; the guard checks only the format.
const jwe =
  "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoiZml4dHVyZSJ9..ucd4hnDSdgKovoQQ.qb4Hy4BREL_wLfXrmEjyLQ.a1rQlNW7OqwgEOn6s6Y9qw";

// A value in the bare hexadecimal format that releases before the keyring wrote.
const earlierFormat = "04170b74ec840be7258e5c66a39a6a3455ee568a0ea14a8df2866f47bf919593";

beforeAll(async () => {
  // Creating the environment applies every migration, including the guard, to JWE data.
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

it("refuses to upgrade while any stored secret location holds a value that is not JWE", async () => {
  const database = environment.database.db;
  const entry = await seedDeployment(database, { bindings: [] });
  const organizationId = "widefleet";

  const [settings] = await database
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId));

  const [provider] = await database
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, organizationId));

  if (!settings || !provider) throw new Error("The test environment has no company sign-in");

  const updateApp = async (values: Partial<typeof apps.$inferInsert>) => {
    await database.update(apps).set(values).where(eq(apps.id, entry.appId));
  };

  const updateSettings = async (values: Partial<typeof organizationSettings.$inferInsert>) => {
    await database
      .update(organizationSettings)
      .set(values)
      .where(eq(organizationSettings.organizationId, organizationId));
  };

  const updateProvider = async (values: Partial<typeof ssoProvider.$inferInsert>) => {
    await database.update(ssoProvider).set(values).where(eq(ssoProvider.id, provider.id));
  };

  const locations: [string, (value: string) => Promise<void>][] = [
    ["app secrets", (value) => updateApp({ secrets: { TOKEN: value } })],
    ["the directory client secret", (value) => updateSettings({ directorySecret: value })],
    ["the app sign-in client secret", (value) => updateSettings({ appClientSecret: value })],
    [
      "a leftover identity document",
      (value) =>
        updateSettings({
          settings: {
            identity: { management: { clientId: "client", secret: { ciphertext: value } } },
          },
        }),
    ],
    ["the SSO provider OIDC configuration", (value) => updateProvider({ oidcConfig: value })],
    ["the SSO provider SAML configuration", (value) => updateProvider({ samlConfig: value })],
  ];

  const restore = async () => {
    await updateApp({ secrets: {} });
    await updateSettings({
      settings: settings.settings,
      directorySecret: settings.directorySecret,
      appClientSecret: settings.appClientSecret,
    });
    await updateProvider({ oidcConfig: provider.oidcConfig, samlConfig: provider.samlConfig });
  };

  await expect(guard()).resolves.toBeDefined();

  try {
    for (const [location, write] of locations) {
      await write(jwe);
      await expect(guard(), location).resolves.toBeDefined();
      await write(earlierFormat);
      await expect(guard(), location).rejects.toThrow(
        /Run "node tools\/secret-encryption.ts reencrypt" on the previous release first/,
      );
      await restore();
    }
  } finally {
    await restore();
  }

  await expect(guard()).resolves.toBeDefined();
});
