import { z } from "zod";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { readConfiguration } from "../src/lib/server/config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { installationKeys } from "../src/lib/server/installation-files.ts";
import { createRecoveryLink } from "../src/lib/server/recovery.ts";

const email = z.email().parse(process.argv[2]);

const input = readConfiguration();

const keys = await installationKeys(input);

const configuration = { ...input, BETTER_AUTH_SECRET: keys.authentication };

const database = createDatabase(configuration);

try {
  const auth = createAuthentication(configuration, database.db);
  console.info(await createRecoveryLink(auth, database.db, configuration, email));
  console.info("This link can be used once. Administrator access expires in 10 minutes.");
} finally {
  await database.close();
}
