import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Configuration } from "./config.ts";
import { readLegacyKey } from "./legacy-secret-migration.ts";
import {
  createSecretEncryption,
  generateKeyVersion,
  includesKeyVersions,
  parseKeyring,
} from "./secret-encryption.ts";

export const readOptionalFile = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(cause).success) return null;
    throw cause;
  }
};

export const writePrivateFile = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
};

export const persistentKey = async (directory: string, name: string) => {
  const path = join(directory, name);
  const existing = await readOptionalFile(path);

  if (existing !== null) return z.string().min(32).parse(existing.trim());
  const value = randomBytes(32).toString("base64url");
  await writePrivateFile(path, value);

  return value;
};

/** Writes `content` unless `path` exists, and returns what `path` then holds. */
const createPrivateFile = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });

  try {
    // Unlike rename, link never replaces a file another process created first.
    await link(temporary, path);

    return { content, created: true };
  } catch (cause) {
    if (!z.object({ code: z.literal("EEXIST") }).safeParse(cause).success) throw cause;

    return { content: await readFile(path, "utf8"), created: false };
  } finally {
    await rm(temporary, { force: true });
  }
};

/**
 * Reads the configured keyring or, without one, the keyring Widefleet keeps in
 * the state directory, created on first start.
 */
const installationKeyring = async (configuration: Configuration) => {
  if (configuration.PLATFORM_ENCRYPTION_KEYS && configuration.PLATFORM_ENCRYPTION_KEYS_FILE)
    throw new Error("Set either PLATFORM_ENCRYPTION_KEYS or PLATFORM_ENCRYPTION_KEYS_FILE");

  const path = join(configuration.PLATFORM_STATE_DIRECTORY, "encryption.keys");
  const stored = await readOptionalFile(path);

  const configured = configuration.PLATFORM_ENCRYPTION_KEYS
    ? parseKeyring(configuration.PLATFORM_ENCRYPTION_KEYS, "PLATFORM_ENCRYPTION_KEYS")
    : configuration.PLATFORM_ENCRYPTION_KEYS_FILE
      ? parseKeyring(
          await readFile(configuration.PLATFORM_ENCRYPTION_KEYS_FILE, "utf8"),
          "PLATFORM_ENCRYPTION_KEYS_FILE",
        )
      : null;

  if (configured) {
    // Values written with the generated keyring must stay readable.
    if (stored !== null && !includesKeyVersions(configured, parseKeyring(stored, path)))
      throw new Error(
        `The configured encryption keyring must include every key version in ${path}. Copy them into it, or remove the file once no stored value uses them.`,
      );

    return configured;
  }

  if (stored !== null) return parseKeyring(stored, path);
  const created = await createPrivateFile(path, `${generateKeyVersion()}\n`);

  if (created.created)
    console.info(
      `Created the encryption keyring ${path}. Back it up, apart from database backups; restoring the database requires it.`,
    );

  return parseKeyring(created.content, path);
};

export const installationKeys = async (configuration: Configuration) => ({
  encryption: createSecretEncryption({
    keyring: await installationKeyring(configuration),
    legacyKey: await readLegacyKey(configuration, readOptionalFile),
  }),
  cookie: await persistentKey(configuration.PLATFORM_STATE_DIRECTORY, "app-cookie.key"),
  authentication:
    configuration.BETTER_AUTH_SECRET ??
    (await persistentKey(configuration.PLATFORM_STATE_DIRECTORY, "authentication.key")),
});
