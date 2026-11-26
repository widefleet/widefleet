import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configurationSchema } from "../src/lib/server/config.ts";
import { ciphertextKeyVersion } from "../src/lib/server/secret-encryption.ts";
import { installationKeys } from "../src/lib/server/installation-files.ts";
import { keySet, keyVersion, keysOf } from "./keyring.fixture.ts";

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
  expect(ciphertextKeyVersion(ciphertext)).toBe(keysOf(await readFile(path, "utf8"))[0]?.kid);
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining(path));

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

it("uses a configured keyring from the environment or a file", async () => {
  const keys = keySet(keyVersion("current"), keyVersion("previous"));
  const path = join(directory, "operator.keys");
  await writeFile(path, keys);

  const fromEnvironment = await installationKeys(configuration({ PLATFORM_ENCRYPTION_KEYS: keys }));
  const fromFile = await installationKeys(configuration({ PLATFORM_ENCRYPTION_KEYS_FILE: path }));
  const ciphertext = await fromEnvironment.encryption.encrypt(context, "value");

  expect(ciphertextKeyVersion(ciphertext)).toBe("current");
  expect(await fromFile.encryption.decrypt(context, ciphertext)).toBe("value");
  await expect(readFile(join(directory, "encryption.keys"))).rejects.toThrow();

  await expect(
    installationKeys(
      configuration({ PLATFORM_ENCRYPTION_KEYS: keys, PLATFORM_ENCRYPTION_KEYS_FILE: path }),
    ),
  ).rejects.toThrow("Set either PLATFORM_ENCRYPTION_KEYS or PLATFORM_ENCRYPTION_KEYS_FILE");
  await expect(
    installationKeys(
      configuration({ PLATFORM_ENCRYPTION_KEYS: keySet(keyVersion("current", "not-a-key")) }),
    ),
  ).rejects.toThrow("PLATFORM_ENCRYPTION_KEYS key 1 must follow");
});

it("requires a configured keyring to keep the generated key versions", async () => {
  const generated = await installationKeys(configuration());
  const ciphertext = await generated.encryption.encrypt(context, "value");
  const stored = keysOf(await readFile(join(directory, "encryption.keys"), "utf8"));
  const operator = keyVersion("operator");

  await expect(
    installationKeys(configuration({ PLATFORM_ENCRYPTION_KEYS: keySet(operator) })),
  ).rejects.toThrow("must include every key version");

  const configured = await installationKeys(
    configuration({ PLATFORM_ENCRYPTION_KEYS: keySet(operator, ...stored) }),
  );

  expect(await configured.encryption.decrypt(context, ciphertext)).toBe("value");
  expect(ciphertextKeyVersion(await configured.encryption.encrypt(context, "value"))).toBe(
    "operator",
  );
});
