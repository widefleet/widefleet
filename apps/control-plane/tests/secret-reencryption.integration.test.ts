import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAppLogin } from "../src/lib/server/app-login-client.ts";
import { storedAppSecrets } from "../src/lib/server/app-secrets.ts";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { apps, organizationSettings } from "../src/lib/server/schema.ts";
import {
  createSecretEncryption,
  parseKeyring,
  type SecretEncryption,
} from "../src/lib/server/secret-encryption.ts";
import {
  createSecretMaintenance,
  readSecretEncryption,
  reencryptSecrets,
} from "../src/lib/server/secret-reencryption.ts";
import { readSsoConfiguration } from "../src/lib/server/sso-settings.ts";
import { organization } from "../src/lib/server/auth-schema.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { createTestEnvironment } from "./environment.ts";
import { checkSecretContexts } from "./secret-contexts.fixture.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

const keyVersion = (id: string) => `${id}:${randomBytes(32).toString("base64url")}`;

const previous = keyVersion("previous");

const current = keyVersion("current");

const service = (keys: string, legacyKey = environment.environment.PLATFORM_ENCRYPTION_KEY) =>
  createSecretEncryption({ legacyKey, keyring: parseKeyring(keys, "test") });

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

/** Stores values of the legacy key and an earlier version in every location. */
const seed = async () => {
  const database = environment.database.db;

  const legacy = createSecretEncryption({
    legacyKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
  });

  const earlier = service(previous);
  const entry = await seedDeployment(database, { bindings: [] });

  const app = { organizationId: entry.organizationId, appId: entry.appId } as const;

  await database
    .update(apps)
    .set({
      secrets: {
        TOKEN: await legacy.encrypt({ kind: "app-secret", ...app, name: "TOKEN" }, "token"),
        OTHER: await earlier.encrypt({ kind: "app-secret", ...app, name: "OTHER" }, "other"),
      },
      secretRevision: 1,
    })
    .where(eq(apps.id, entry.appId));

  const [provider] = await database
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, "widefleet"));

  const oidc = { kind: "sso-provider-config", field: "oidcConfig" } as const;

  await database
    .update(ssoProvider)
    .set({
      oidcConfig: await earlier.encrypt(
        oidc,
        await environment.encryption.decrypt(oidc, provider?.oidcConfig ?? ""),
      ),
      samlConfig: await legacy.encrypt(
        { kind: "sso-provider-config", field: "samlConfig" },
        JSON.stringify({ entryPoint: "https://saml.example.test" }),
      ),
    })
    .where(eq(ssoProvider.organizationId, "widefleet"));
  await database
    .update(organizationSettings)
    .set({
      directorySecret: await earlier.encrypt(
        { kind: "directory-client-secret", organizationId: "widefleet" },
        "directory-secret",
      ),
      appClientSecret: await legacy.encrypt(
        { kind: "app-login-client-secret", organizationId: "widefleet" },
        "app-login-secret",
      ),
    })
    .where(eq(organizationSettings.organizationId, "widefleet"));

  const legacyOrganization = crypto.randomUUID();
  await database.insert(organization).values({
    id: legacyOrganization,
    name: "Legacy settings",
    slug: `legacy-${legacyOrganization}`,
    createdAt: new Date(),
  });
  await database.insert(organizationSettings).values({
    organizationId: legacyOrganization,
    settings: {
      externallyManaged: false,
      identity: {
        management: {
          clientId: "legacy-client",
          secret: {
            ciphertext: await legacy.encrypt(
              { kind: "legacy-sso-client-secret", organizationId: legacyOrganization },
              "legacy-secret",
            ),
          },
        },
      },
    },
  });

  return { entry, legacyOrganization };
};

const remaining = (status: Awaited<ReturnType<typeof readSecretEncryption>>) =>
  status.keyVersions.filter((version) => !version.active).reduce((sum, v) => sum + v.values, 0);

describe("re-encryption", () => {
  it("moves every location to the active version, reports progress and resumes", async () => {
    const { entry, legacyOrganization } = await seed();
    const database = environment.database.db;

    // The environment's own values use its synthetic `test` version.
    const encryption = checkSecretContexts(
      service(`${current},${environment.environment.PLATFORM_ENCRYPTION_KEYS},${previous}`),
    );

    const before = await readSecretEncryption(database, encryption);

    expect(before.activeKeyVersion).toBe("current");
    expect(before.keyVersions).toEqual(
      expect.arrayContaining([
        { id: "current", values: 0, active: true, available: true },
        expect.objectContaining({ id: null, active: false, available: true }),
        expect.objectContaining({ id: "previous", active: false, available: true }),
      ]),
    );
    expect(before.keyVersions.find((version) => version.id === null)?.values).toBe(4);
    expect(before.keyVersions.find((version) => version.id === "previous")?.values).toBe(3);

    const total = remaining(before);
    const result = await reencryptSecrets(database, encryption);

    expect(result).toMatchObject({ reencrypted: total, changed: 0, failed: 0 });
    expect(result.status.keyVersions).toEqual([
      { id: "current", values: total, active: true, available: true },
      { id: "test", values: 0, active: false, available: true },
      { id: "previous", values: 0, active: false, available: true },
      { id: null, values: 0, active: false, available: true },
    ]);
    expect((await reencryptSecrets(database, encryption)).reencrypted).toBe(0);

    // Readers find every value, with the contexts re-encryption used.
    const [app] = await database.select().from(apps).where(eq(apps.id, entry.appId));
    const context = { organizationId: entry.organizationId, appId: entry.appId } as const;

    expect(app?.secretRevision).toBe(1);
    expect(
      await encryption.decrypt(
        { kind: "app-secret", ...context, name: "OTHER" },
        storedAppSecrets.parse(app?.secrets)["OTHER"] ?? "",
      ),
    ).toBe("other");
    expect(
      (await readSsoConfiguration(database, encryption, "widefleet"))?.oidcConfig.clientSecret,
    ).toBeTruthy();
    expect(
      (await readAppLogin(database, environment.configuration, encryption, "widefleet"))?.management
        .clientSecret,
    ).toBe("app-login-secret");

    const [legacy] = await database
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, legacyOrganization));

    expect(JSON.stringify(legacy?.settings)).toContain('"ciphertext":"v1:current:');

    // Earlier keys can go once nothing uses them.
    const onlyCurrent = service(current, "another-synthetic-legacy-key");

    expect(
      await onlyCurrent.decrypt(
        { kind: "directory-client-secret", organizationId: "widefleet" },
        (
          await database
            .select({ value: organizationSettings.directorySecret })
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, "widefleet"))
        )[0]?.value ?? "",
      ),
    ).toBe("directory-secret");
    expect(remaining(await readSecretEncryption(database, onlyCurrent))).toBe(0);
  });

  it("keeps a value written while it was being re-encrypted and counts values it cannot read", async () => {
    const database = environment.database.db;
    const context = { kind: "directory-client-secret", organizationId: "widefleet" } as const;
    const earlier = service(previous);
    const stored = await earlier.encrypt(context, "before");
    const written = await earlier.encrypt(context, "written concurrently");
    const missing = await service(keyVersion("missing")).encrypt(context, "unreadable");
    const target = service(`${current},${previous}`);

    await database
      .update(organizationSettings)
      .set({ directorySecret: stored, appClientSecret: missing })
      .where(eq(organizationSettings.organizationId, "widefleet"));

    // Another writer saves the directory secret after it was read.
    const racing: SecretEncryption = {
      ...target,
      decrypt: async (decryptContext, ciphertext) => {
        if (ciphertext === stored)
          await database
            .update(organizationSettings)
            .set({ directorySecret: written })
            .where(eq(organizationSettings.organizationId, "widefleet"));

        return target.decrypt(decryptContext, ciphertext);
      },
    };

    const first = await reencryptSecrets(database, racing);

    expect(first).toMatchObject({ changed: 1, failed: 1 });
    expect(first.status.keyVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "previous", values: 1 }),
        expect.objectContaining({ id: "missing", values: 1, available: false }),
      ]),
    );

    const [kept] = await database
      .select({ value: organizationSettings.directorySecret })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, "widefleet"));

    expect(kept?.value).toBe(written);

    const second = await reencryptSecrets(database, target);

    expect(second).toMatchObject({ reencrypted: 1, changed: 0, failed: 1 });
    expect(
      await target.decrypt(
        context,
        (
          await database
            .select({ value: organizationSettings.directorySecret })
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, "widefleet"))
        )[0]?.value ?? "",
      ),
    ).toBe("written concurrently");
  });

  it("lets only installation administrators read and run it", async () => {
    const maintenance = createSecretMaintenance(environment.database.db, environment.encryption);

    const principal = {
      ...environment.owner,
      role: "admin" as const,
      admin: false,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    };

    expect((await maintenance.status(principal)).isErr()).toBe(true);
    expect((await maintenance.reencrypt(principal)).isErr()).toBe(true);
    expect((await maintenance.status({ ...principal, admin: true })).isOk()).toBe(true);
  });
});
