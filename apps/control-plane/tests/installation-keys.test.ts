import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symmetricEncrypt } from "better-auth/crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configurationSchema } from "../src/lib/server/config.ts";
import { installationKeys } from "../src/lib/server/installation-files.ts";

const context = { kind: "app-login-client-secret", organizationId: "widefleet" } as const;

let directory: string;

const configuration = (settings: Record<string, string> = {}) =>
  configurationSchema.parse({
    DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:5432/synthetic",
    PLATFORM_URL: "https://platform.example.test",
    APP_DOMAIN: "apps.example.test",
    S3_ENDPOINT: "http://127.0.0.1:25400",
    S3_BUCKET: "artifacts",
    S3_ACCESS_KEY_ID: "local-tests",
    S3_SECRET_ACCESS_KEY: "local-tests-only",
    PLATFORM_STATE_DIRECTORY: directory,
    ...settings,
  });

const keyVersion = (id: string) => `${id}:${randomBytes(32).toString("base64")}`;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "widefleet-keys-"));
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it("creates a private keyring on first start and keeps using it", async () => {
  const first = await installationKeys(configuration());
  const path = join(directory, "encryption.keys");
  const ciphertext = await first.encryption.encrypt(context, "synthetic secret");

  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(ciphertext).toMatch(new RegExp(`^v1:${(await readFile(path, "utf8")).split(":")[0]}:`));
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining(path));
  // Only installations from before the keyring have a legacy key.
  await expect(stat(join(directory, "encryption.key"))).rejects.toThrow();

  const restarted = await installationKeys(configuration());

  expect(await restarted.encryption.decrypt(context, ciphertext)).toBe("synthetic secret");
});

it("agrees on one keyring when processes start together", async () => {
  const [first, second] = await Promise.all([
    installationKeys(configuration()),
    installationKeys(configuration()),
  ]);

  expect(
    await second.encryption.decrypt(context, await first.encryption.encrypt(context, "value")),
  ).toBe("value");
});

it("upgrades an installation with only a legacy key without configuration changes", async () => {
  const legacyKey = randomBytes(32).toString("base64url");
  await writeFile(join(directory, "encryption.key"), legacyKey);
  const stored = await symmetricEncrypt({ key: legacyKey, data: "written by an earlier release" });

  const { encryption } = await installationKeys(configuration());

  expect(await encryption.decrypt(context, stored)).toBe("written by an earlier release");
  expect(await encryption.encrypt(context, "new value")).toMatch(/^v1:/);
});

it("keeps an operator-managed legacy key for earlier ciphertexts", async () => {
  const legacyKey = "synthetic-operator-managed-legacy-key";
  const stored = await symmetricEncrypt({ key: legacyKey, data: "earlier" });

  const { encryption } = await installationKeys(
    configuration({ PLATFORM_ENCRYPTION_KEY: legacyKey }),
  );

  expect(await encryption.decrypt(context, stored)).toBe("earlier");
});

it("uses a configured keyring from the environment or a file", async () => {
  const keys = `${keyVersion("current")},${keyVersion("previous")}`;
  const path = join(directory, "operator.keys");
  await writeFile(path, keys.replace(",", "\n"));

  const fromEnvironment = await installationKeys(configuration({ PLATFORM_ENCRYPTION_KEYS: keys }));
  const fromFile = await installationKeys(configuration({ PLATFORM_ENCRYPTION_KEYS_FILE: path }));
  const ciphertext = await fromEnvironment.encryption.encrypt(context, "value");

  expect(ciphertext).toMatch(/^v1:current:/);
  expect(await fromFile.encryption.decrypt(context, ciphertext)).toBe("value");
  await expect(readFile(join(directory, "encryption.keys"))).rejects.toThrow();

  await expect(
    installationKeys(
      configuration({ PLATFORM_ENCRYPTION_KEYS: keys, PLATFORM_ENCRYPTION_KEYS_FILE: path }),
    ),
  ).rejects.toThrow("Set either PLATFORM_ENCRYPTION_KEYS or PLATFORM_ENCRYPTION_KEYS_FILE");
  await expect(
    installationKeys(configuration({ PLATFORM_ENCRYPTION_KEYS: "current:not-a-key" })),
  ).rejects.toThrow("PLATFORM_ENCRYPTION_KEYS entry 1 must be");
});

it("requires a configured keyring to keep the generated key versions", async () => {
  const generated = await installationKeys(configuration());
  const ciphertext = await generated.encryption.encrypt(context, "value");
  const stored = (await readFile(join(directory, "encryption.keys"), "utf8")).trim();

  await expect(
    installationKeys(configuration({ PLATFORM_ENCRYPTION_KEYS: keyVersion("operator") })),
  ).rejects.toThrow("must include every key version");

  const configured = await installationKeys(
    configuration({ PLATFORM_ENCRYPTION_KEYS: `${keyVersion("operator")},${stored}` }),
  );

  expect(await configured.encryption.decrypt(context, ciphertext)).toBe("value");
  expect(await configured.encryption.encrypt(context, "value")).toMatch(/^v1:operator:/);
});
