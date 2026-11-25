/**
 * TEMPORARY MIGRATION CODE. Releases before the encryption keyring stored
 * secrets as bare hexadecimal from better-auth's `symmetricEncrypt`, under one
 * installation key. Everything that exists only for that format lives in this
 * module. Operators re-encrypt stored secrets with the active key version on a
 * release that still has it; the cleanup release then deletes this module and
 * the legacy key settings, behind a migration that refuses to start while any
 * legacy ciphertext remains.
 */
import { join } from "node:path";
import { symmetricDecrypt } from "better-auth/crypto";
import { z } from "zod";

/** Legacy ciphertexts are bare hexadecimal; versioned ones contain colons. */
export const isLegacyCiphertext = (ciphertext: string) => !ciphertext.includes(":");

export const decryptLegacySecret = async (key: string | undefined, ciphertext: string) => {
  if (key === undefined) throw new Error("No legacy encryption key is configured");

  return symmetricDecrypt({ key, data: ciphertext });
};

/**
 * The legacy key from settings that need no file access. Without
 * `PLATFORM_ENCRYPTION_KEY`, authentication used `BETTER_AUTH_SECRET`.
 */
export const configuredLegacyKey = (configuration: {
  PLATFORM_ENCRYPTION_KEY?: string | undefined;
  BETTER_AUTH_SECRET?: string | undefined;
}) => configuration.PLATFORM_ENCRYPTION_KEY ?? configuration.BETTER_AUTH_SECRET;

/**
 * The legacy key of a Node installation: `PLATFORM_ENCRYPTION_KEY`, the file
 * named by `PLATFORM_ENCRYPTION_KEY_FILE`, or the `encryption.key` that earlier
 * releases generated in the state directory. New installations have none.
 */
export const readLegacyKey = async (
  configuration: {
    PLATFORM_ENCRYPTION_KEY?: string | undefined;
    PLATFORM_ENCRYPTION_KEY_FILE?: string | undefined;
    PLATFORM_STATE_DIRECTORY: string;
  },
  read: (path: string) => Promise<string | null>,
) => {
  if (configuration.PLATFORM_ENCRYPTION_KEY && configuration.PLATFORM_ENCRYPTION_KEY_FILE)
    throw new Error("Set either PLATFORM_ENCRYPTION_KEY or PLATFORM_ENCRYPTION_KEY_FILE");

  if (configuration.PLATFORM_ENCRYPTION_KEY) return configuration.PLATFORM_ENCRYPTION_KEY;

  const path =
    configuration.PLATFORM_ENCRYPTION_KEY_FILE ??
    join(configuration.PLATFORM_STATE_DIRECTORY, "encryption.key");

  const stored = await read(path);

  if (stored === null && configuration.PLATFORM_ENCRYPTION_KEY_FILE)
    throw new Error("PLATFORM_ENCRYPTION_KEY_FILE does not exist");

  return stored === null ? undefined : z.string().min(32).parse(stored.trim());
};
