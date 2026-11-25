import { z } from "zod";
import { runtimeConfigurationSchema } from "../src/lib/server/config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { readInstallationKeyring, readOptionalFile } from "../src/lib/server/installation-files.ts";
import { readLegacyKey } from "../src/lib/server/legacy-secret-migration.ts";
import { createSecretEncryption } from "../src/lib/server/secret-encryption.ts";
import {
  incomplete,
  readSecretEncryption,
  reencryptSecrets,
} from "../src/lib/server/secret-reencryption.ts";

// Usage: node tools/secret-encryption.ts status|reencrypt
// Runs inside the control-plane container, or from CI with explicit settings.
const command = z
  .enum(["status", "reencrypt"], {
    error: "Usage: node tools/secret-encryption.ts status|reencrypt",
  })
  .parse(process.argv[2]);

// Only the settings this command needs, so CI can run it with a small environment.
const configuration = runtimeConfigurationSchema
  .pick({
    DATABASE_URL: true,
    PLATFORM_STATE_DIRECTORY: true,
    PLATFORM_ENCRYPTION_KEYS: true,
    PLATFORM_ENCRYPTION_KEYS_FILE: true,
    PLATFORM_ENCRYPTION_KEY: true,
    PLATFORM_ENCRYPTION_KEY_FILE: true,
  })
  .parse(process.env);

// Re-encrypting under a key nobody keeps would lose the secrets, so this never creates one.
const keyring = await readInstallationKeyring(configuration);

if (!keyring)
  throw new Error(
    "No encryption keyring found. Set PLATFORM_ENCRYPTION_KEYS or PLATFORM_ENCRYPTION_KEYS_FILE, or run this where the control plane keeps encryption.keys in PLATFORM_STATE_DIRECTORY.",
  );

const encryption = createSecretEncryption({
  keyring,
  legacyKey: await readLegacyKey(configuration, readOptionalFile),
});

const database = createDatabase(configuration, 2);

try {
  const result =
    command === "reencrypt"
      ? await reencryptSecrets(database.db, encryption, (rows) =>
          console.error(`Checked ${rows} rows`),
        )
      : null;

  const status = await readSecretEncryption(database.db, encryption);

  console.info(JSON.stringify(result ? { ...result, status } : status, null, 2));

  if (status.failed > 0 || (result && (result.failed > 0 || incomplete(status)))) {
    console.error(
      status.failed > 0 || (result?.failed ?? 0) > 0
        ? "Some stored secrets could not be decrypted. Restore their key versions or the legacy key, then run this again."
        : "Some stored secrets still use another key version, for example because they changed during the run. Run this again.",
    );
    process.exitCode = 1;
  }
} finally {
  await database.close();
}
