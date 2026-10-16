import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { bootstrapConfiguration } from "@platform/contracts";
import { createAuthentication, registerCli } from "../src/lib/server/auth.ts";
import { cloudflareConfigurationSchema } from "../src/lib/server/cloudflare-config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import {
  createInstallationOwner,
  initializeInstallation,
  readInstallation,
} from "../src/lib/server/installation-store.ts";
import { initializeCloudflareFleet } from "../src/lib/server/fleets.ts";
import { initializeOrganization } from "../src/lib/server/organization.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import { z } from "zod";
import { createCloudflareAppSignIn } from "../src/lib/server/app-sign-in-cloudflare.ts";
import { getPlatformProxy } from "wrangler";
import type { AuthProxyBindings } from "../src/lib/server/cloudflare-auth-proxy.ts";

const configuration = cloudflareConfigurationSchema.parse(process.env);

const database = createDatabase(configuration);

try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  const fleet = await initializeCloudflareFleet(database.db);

  if (fleet.isErr()) throw fleet.error;
  await initializeOrganization(database.db);
  await initializeInstallation(database.db);
  await registerCli(createAuthentication(configuration, database.db), database.db, configuration);

  if (!(await readInstallation(database.db)).ownerId) {
    if (!configuration.PLATFORM_BOOTSTRAP_FILE)
      throw new Error("PLATFORM_BOOTSTRAP_FILE must provide the first hosted administrator");

    const bootstrap = bootstrapConfiguration.parse(
      JSON.parse(await readFile(configuration.PLATFORM_BOOTSTRAP_FILE, "utf8")),
    );

    if (bootstrap.settings) {
      const secrets = z.object({ APP_COOKIE_SECRET: z.string().min(1) }).parse(process.env);

      const proxy = await getPlatformProxy<AuthProxyBindings>({
        configPath:
          process.env["WIDEFLEET_INITIALIZE_CONFIG"] ??
          fileURLToPath(new URL("../wrangler.initialize.jsonc", import.meta.url)),
        persist: false,
      });

      try {
        const settings = createSettingsService(
          configuration,
          database.db,
          configuration.PLATFORM_ENCRYPTION_KEY,
          createCloudflareAppSignIn(configuration, {
            ...proxy.env,
            ...secrets,
          }),
        );

        const initialized = await settings.initialize(bootstrap.settings);

        if (initialized.error) throw new Error(initialized.error);
      } finally {
        await proxy.dispose();
      }
    }

    await createInstallationOwner(database.db, bootstrap.owner);
  }

  console.info("Hosted installation initialized");
} finally {
  await database.close();
}
