import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { bootstrapConfiguration } from "@platform/contracts";
import { initializeBootstrap } from "../src/lib/server/bootstrap.ts";
import { migrateSsoSettings } from "../src/lib/server/sso-migration.ts";
import { createAuthentication, registerCli } from "../src/lib/server/auth.ts";
import { cloudflareConfigurationSchema } from "../src/lib/server/cloudflare-config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import {
  createInstallationOwner,
  initializeInstallation,
  readInstallation,
} from "../src/lib/server/installation-store.ts";
import { initializeCloudflareRuntime } from "../src/lib/server/organization-runtime.ts";
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
  const execution = await initializeCloudflareRuntime(database.db);

  if (execution.isErr()) throw execution.error;
  await initializeOrganization(database.db);
  await initializeInstallation(database.db);
  await migrateSsoSettings(database.db, configuration.PLATFORM_ENCRYPTION_KEY);
  await registerCli(database.db, configuration);

  const state = await readInstallation(database.db);

  if (!state.ownerId || state.bootstrapPending) {
    if (!configuration.PLATFORM_BOOTSTRAP_FILE)
      throw new Error("PLATFORM_BOOTSTRAP_FILE must provide the first hosted administrator");

    const bootstrap = bootstrapConfiguration.parse(
      JSON.parse(await readFile(configuration.PLATFORM_BOOTSTRAP_FILE, "utf8")),
    );

    if (bootstrap.settings || state.bootstrapPending) {
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
          (organizationId) =>
            createCloudflareAppSignIn(
              configuration,
              {
                ...proxy.env,
                ...secrets,
              },
              organizationId,
            ),
        );

        await initializeBootstrap(
          settings,
          createAuthentication({ ...configuration, LOCAL_PASSWORD_ENABLED: true }, database.db),
          database.db,
          bootstrap,
        );
      } finally {
        await proxy.dispose();
      }
    } else await createInstallationOwner(database.db, bootstrap.owner);
  }

  console.info("Hosted installation initialized");
} finally {
  await database.close();
}
