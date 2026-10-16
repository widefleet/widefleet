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
import { appCallbackUrl } from "../src/lib/server/app-sign-in.ts";

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
      const settings = createSettingsService(
        configuration,
        database.db,
        configuration.PLATFORM_ENCRYPTION_KEY,
        createCloudflareAppSignIn(configuration, {
          ...z
            .object({ APP_RUNTIME_TOKEN: z.string().min(32), APP_COOKIE_SECRET: z.string().min(1) })
            .parse(process.env),
          APP_RUNTIME: {
            fetch: (url, init) =>
              fetch(new URL(new URL(url).pathname, appCallbackUrl(configuration)), {
                ...init,
                redirect: "error",
              }),
          },
        }),
      );

      await settings.initialize(bootstrap.settings);
    }

    await createInstallationOwner(database.db, bootstrap.owner);
  }

  console.info("Hosted installation initialized");
} finally {
  await database.close();
}
