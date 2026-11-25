import { readConfiguration } from "../src/lib/server/config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { installationKeys } from "../src/lib/server/installation-files.ts";
import {
  readSecretEncryption,
  reencryptAllSecrets,
} from "../src/lib/server/secret-reencryption.ts";

const command = process.argv[2];

if (command !== "status" && command !== "reencrypt")
  throw new Error("Usage: node tools/secret-encryption.ts status|reencrypt");

const configuration = readConfiguration();

const { encryption } = await installationKeys(configuration);

const database = createDatabase(configuration);

try {
  if (command === "reencrypt") {
    let done = 0;

    const total = await reencryptAllSecrets(database.db, encryption, (batch) => {
      done += batch.reencrypted;
      console.error(`Re-encrypted ${done} secrets so far`);
    });

    console.info(JSON.stringify(total, null, 2));
  }

  console.info(JSON.stringify(await readSecretEncryption(database.db, encryption), null, 2));
} finally {
  await database.close();
}
