import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { CompactEncrypt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAppLogin } from "../src/lib/server/app-login-client.ts";
import { storedAppSecrets } from "../src/lib/server/app-secrets.ts";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { apps, organizationSettings } from "../src/lib/server/schema.ts";
import { parseKeyring } from "@platform/contracts/keyring";
import {
  createSecretEncryption,
  type SecretEncryption,
} from "../src/lib/server/secret-encryption.ts";
import {
  incomplete,
  readSecretEncryption,
  reencryptSecrets,
} from "../src/lib/server/secret-reencryption.ts";
import { readSsoConfiguration } from "../src/lib/server/sso-settings.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { createTestEnvironment } from "./environment.ts";
import { checkSecretContexts } from "./secret-contexts.fixture.ts";
import { keySet, keyVersion, keysOf } from "./keyring.fixture.ts";

const execute = promisify(execFile);

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

const previous = keyVersion("previous");

const current = keyVersion("current");

const oldest = keyVersion("oldest");

const service = (keys: ReturnType<typeof keyVersion>[]) =>
  createSecretEncryption({ keyring: parseKeyring(keySet(...keys), "test") });

/**
 * Writes values as they were stored before keys per kind and context binding:
 * the oldest version's bytes and its ID alone as `kid`.
 */
const older = (value: string) =>
  new CompactEncrypt(new TextEncoder().encode(value))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: oldest.kid })
    .encrypt(Buffer.from(oldest.k, "base64url"));

/** The environment's key versions, which encrypted its fixture values. */
const environmentKeys = () => keysOf(environment.environment.PLATFORM_ENCRYPTION_KEYS);

/** The keyring after rotation: new active version, the environment's, then an older one. */
const rotated = () =>
  checkSecretContexts(service([current, ...environmentKeys(), previous, oldest]));

const directorySecret = async () =>
  (
    await environment.database.db
      .select({ value: organizationSettings.directorySecret })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, "widefleet"))
  )[0]?.value ?? "";

const setDirectorySecret = (value: string | null) =>
  environment.database.db
    .update(organizationSettings)
    .set({ directorySecret: value })
    .where(eq(organizationSettings.organizationId, "widefleet"));

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

describe("re-encryption", () => {
  it("moves every location to the active version, keyed by slot, and resumes", async () => {
    const database = environment.database.db;
    const earlier = service([previous]);
    const entry = await seedDeployment(database, { bindings: [] });
    const app = { organizationId: entry.organizationId, appId: entry.appId } as const;
    // Two names that hold the same ciphertext still get their own values.
    const shared = await older("shared");

    await database
      .update(apps)
      .set({
        secrets: {
          TOKEN: await older("token"),
          OTHER: await earlier.encrypt({ kind: "app-secret", ...app, name: "OTHER" }, "other"),
          FIRST: shared,
          SECOND: shared,
        },
        secretRevision: 1,
      })
      .where(eq(apps.id, entry.appId));

    const oidc = { kind: "sso-provider-config", field: "oidcConfig" } as const;

    const [provider] = await database
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, "widefleet"));

    await database
      .update(ssoProvider)
      .set({
        oidcConfig: await earlier.encrypt(
          oidc,
          await environment.encryption.decrypt(oidc, provider?.oidcConfig ?? ""),
        ),
        samlConfig: await older(JSON.stringify({ entryPoint: "https://saml.example.test" })),
      })
      .where(eq(ssoProvider.organizationId, "widefleet"));
    await database
      .update(organizationSettings)
      .set({
        directorySecret: await earlier.encrypt(
          { kind: "directory-client-secret", organizationId: "widefleet" },
          "directory-secret",
        ),
        appClientSecret: await older("app-login-secret"),
      })
      .where(eq(organizationSettings.organizationId, "widefleet"));

    const encryption = rotated();
    const before = await readSecretEncryption(database, encryption);

    expect(before).toMatchObject({ activeKeyVersion: "current", earlierFormat: 5, failed: 0 });
    expect(before.keyVersions).toMatchObject({ current: 0, previous: 3, oldest: 5 });
    expect(incomplete(before)).toBe(true);

    const result = await reencryptSecrets(database, encryption);
    const after = await readSecretEncryption(database, encryption);

    expect(result).toMatchObject({ changed: 0, failed: 0 });
    expect(result.reencrypted).toBe(Object.values(before.keyVersions).reduce((a, b) => a + b, 0));
    expect(after).toMatchObject({ earlierFormat: 0, failed: 0 });
    expect(after.keyVersions).toMatchObject({
      current: result.reencrypted,
      previous: 0,
      oldest: 0,
      test: 0,
    });
    expect(incomplete(after)).toBe(false);
    expect((await reencryptSecrets(database, encryption)).reencrypted).toBe(0);

    // Readers find every value, with the contexts re-encryption used.
    const [saved] = await database.select().from(apps).where(eq(apps.id, entry.appId));
    const values = storedAppSecrets.parse(saved?.secrets);

    expect(saved?.secretRevision).toBe(1);
    expect(values["FIRST"]).not.toBe(values["SECOND"]);

    for (const name of ["FIRST", "SECOND"])
      expect(
        await encryption.decrypt({ kind: "app-secret", ...app, name }, values[name] ?? ""),
      ).toBe("shared");
    expect(
      (await readSsoConfiguration(database, encryption, "widefleet"))?.oidcConfig.clientSecret,
    ).toBeTruthy();
    expect(
      (await readAppLogin(database, environment.configuration, encryption, "widefleet"))?.management
        .clientSecret,
    ).toBe("app-login-secret");

    // The active version alone now reads everything; earlier keys can go.
    expect(
      await service([current]).decrypt(
        { kind: "directory-client-secret", organizationId: "widefleet" },
        await directorySecret(),
      ),
    ).toBe("directory-secret");
  });

  it("decrypts values that already name the active version instead of trusting the header", async () => {
    const database = environment.database.db;
    const encryption = rotated();
    const stored = await directorySecret();
    const parts = stored.split(".");
    const tag = parts[4] ?? "";
    // The header still names the active version, but the value no longer decrypts.
    const altered = [...parts.slice(0, 4), `${tag.at(0) === "A" ? "B" : "A"}${tag.slice(1)}`];

    await setDirectorySecret(altered.join("."));

    try {
      expect((await readSecretEncryption(database, encryption)).failed).toBe(1);
      expect(await reencryptSecrets(database, encryption)).toMatchObject({ failed: 1 });
      expect(await directorySecret()).toBe(altered.join("."));
    } finally {
      await setDirectorySecret(stored);
    }
  });

  it("keeps a value written while it was being re-encrypted", async () => {
    const database = environment.database.db;
    const context = { kind: "directory-client-secret", organizationId: "widefleet" } as const;
    const earlier = service([previous]);
    const original = await directorySecret();
    const stored = await earlier.encrypt(context, "before");
    const written = await earlier.encrypt(context, "written concurrently");
    const target = rotated();

    await setDirectorySecret(stored);

    // Another writer saves the directory secret after it was read.
    const racing: SecretEncryption = {
      ...target,
      decrypt: async (decryptContext, ciphertext) => {
        if (ciphertext === stored) await setDirectorySecret(written);

        return target.decrypt(decryptContext, ciphertext);
      },
    };

    try {
      expect(await reencryptSecrets(database, racing)).toMatchObject({ changed: 1, failed: 0 });
      expect(await directorySecret()).toBe(written);
      expect(await reencryptSecrets(database, target)).toMatchObject({ reencrypted: 1 });
      expect(await target.decrypt(context, await directorySecret())).toBe("written concurrently");
    } finally {
      await setDirectorySecret(original);
    }
  });

  it("counts key versions by ID, even IDs named constructor or __proto__", async () => {
    const database = environment.database.db;
    const named = keyVersion("named");
    const encryption = service([named, current, ...environmentKeys(), previous, oldest]);
    const entry = await seedDeployment(database, { bindings: [] });

    const context = {
      kind: "app-secret",
      organizationId: entry.organizationId,
      appId: entry.appId,
    } as const;

    const before = await readSecretEncryption(database, encryption);

    // Values that name key versions the keyring does not hold.
    const missing = (kid: string) =>
      new CompactEncrypt(new TextEncoder().encode("value"))
        .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid })
        .encrypt(randomBytes(32));

    await database
      .update(apps)
      .set({
        secrets: {
          ACTIVE: await encryption.encrypt({ ...context, name: "ACTIVE" }, "active"),
          CONSTRUCTOR: await missing("constructor"),
          PROTO: await missing("__proto__"),
        },
        secretRevision: 1,
      })
      .where(eq(apps.id, entry.appId));

    try {
      const status = await readSecretEncryption(database, encryption);
      const counts = new Map(Object.entries(status.keyVersions));

      expect(status.failed).toBe(before.failed + 2);
      expect([counts.get("named"), counts.get("constructor"), counts.get("__proto__")]).toEqual([
        1, 1, 1,
      ]);
      expect(JSON.stringify(status.keyVersions)).toContain('"__proto__":1');
    } finally {
      await database
        .update(apps)
        .set({ secrets: {}, secretRevision: 0 })
        .where(eq(apps.id, entry.appId));
    }
  });
});

describe("the re-encryption command", () => {
  const command = fileURLToPath(new URL("../tools/secret-encryption.ts", import.meta.url));

  const run = async (action: string, settings: Record<string, string>) => {
    try {
      const { stdout } = await execute(process.execPath, [command, action], {
        env: { PATH: process.env["PATH"], ...settings },
      });

      return { code: 0, stdout };
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));

      return { code: 1, stdout: "", message: failure.message };
    }
  };

  // Four command runs, each a Node process that loads the control plane.
  it("never creates keys and exits nonzero while a value does not decrypt", async () => {
    const state = await mkdtemp(join(tmpdir(), "widefleet-reencryption-"));

    const settings = {
      DATABASE_URL: environment.environment.DATABASE_URL,
      PLATFORM_STATE_DIRECTORY: state,
    };

    try {
      const withoutKeys = await run("status", settings);

      expect(withoutKeys).toMatchObject({ code: 1 });
      expect(withoutKeys.message).toContain("No encryption keyring found");
      expect(await readdir(state)).toEqual([]);

      const keys = {
        ...settings,
        PLATFORM_ENCRYPTION_KEYS: keySet(current, ...environmentKeys()),
      };

      const reencrypted = await run("reencrypt", keys);

      expect(reencrypted).toMatchObject({ code: 0 });
      expect(JSON.parse(reencrypted.stdout)).toMatchObject({
        failed: 0,
        status: { activeKeyVersion: "current", failed: 0 },
      });

      // A value under a key version the keyring does not hold.
      const original = await directorySecret();

      await setDirectorySecret(
        await new CompactEncrypt(new TextEncoder().encode("unreadable"))
          .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: "missing" })
          .encrypt(randomBytes(32)),
      );

      try {
        expect(await run("status", keys)).toMatchObject({ code: 1 });
      } finally {
        await setDirectorySecret(original);
      }

      expect(await run("status", keys)).toMatchObject({ code: 0 });
      expect(await readdir(state)).toEqual([]);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  }, 30_000);
});
