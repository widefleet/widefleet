import { createProductAnalytics } from "../src/lib/server/analytics.ts";
import { getPlatformProxy } from "wrangler";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { cloudflareConfigurationSchema } from "../src/lib/server/cloudflare-config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import {
  initializeCloudflareInstallation,
  type InitializationPlatform,
} from "./cloudflare-initialization.ts";

const configuration = cloudflareConfigurationSchema.parse(process.env);

const database = createDatabase(configuration);

const observation = createProductAnalytics(configuration);

const configPath =
  process.env["WIDEFLEET_INITIALIZE_CONFIG"] ??
  fileURLToPath(new URL("../wrangler.initialize.jsonc", import.meta.url));

let proxy: Awaited<ReturnType<typeof getPlatformProxy<InitializationPlatform>>> | undefined;

try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  await initializeCloudflareInstallation({
    configuration,
    database: database.db,
    observation,
    environment: process.env,
    configPath,
    secretsPath: process.env["WIDEFLEET_INITIALIZE_SECRETS_FILE"],
    bootstrapFile: configuration.PLATFORM_BOOTSTRAP_FILE,
    platform: async () => {
      proxy = await getPlatformProxy<InitializationPlatform>({ configPath, persist: false });

      return proxy.env;
    },
  });
} finally {
  try {
    await proxy?.dispose();
  } finally {
    await observation.close();
    await database.close();
  }
}
