import { readConfiguration } from "../src/lib/server/config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { installationKeys } from "../src/lib/server/installation-files.ts";
import { readSecretEncryption, reencryptSecrets } from "../src/lib/server/secret-reencryption.ts";

const command = process.argv[2];

if (command !== "status" && command !== "reencrypt")
  throw new Error("Usage: node tools/secret-encryption.ts status|reencrypt");

const configuration = readConfiguration();

const { encryption } = await installationKeys(configuration);

const database = createDatabase(configuration);

try {
  const result =
    command === "status"
      ? await readSecretEncryption(database.db, encryption)
      : await reencryptSecrets(database.db, encryption);

  console.info(JSON.stringify(result, null, 2));
} finally {
  await database.close();
}
