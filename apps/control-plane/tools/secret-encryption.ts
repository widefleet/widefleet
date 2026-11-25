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
  if (command === "status")
    console.info(JSON.stringify(await readSecretEncryption(database.db, encryption), null, 2));
  else {
    let done = 0;

    const result = await reencryptAllSecrets(database.db, encryption, (batch) => {
      done += batch.reencrypted;
      console.error(`Re-encrypted ${done} secrets so far`);
    });

    console.info(JSON.stringify(result, null, 2));
  }
} finally {
  await database.close();
}
