import { createProductAnalytics } from "../src/lib/server/analytics.ts";
import { unstable_readConfig } from "wrangler";
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
import { z } from "zod";
import { connectCloudflareSettings } from "./cloudflare-settings.ts";
import { loadRuntimeExtension } from "./runtime-extension.ts";
import { closeObservation } from "../src/lib/server/observation.ts";

const configuration = cloudflareConfigurationSchema.parse(process.env);

const database = createDatabase(configuration);

const observation = createProductAnalytics(configuration);

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

    const extension = await loadRuntimeExtension({ configuration, database: database.db });

    const configPath =
      process.env["WIDEFLEET_INITIALIZE_CONFIG"] ??
      fileURLToPath(new URL("../wrangler.initialize.jsonc", import.meta.url));

    const worker = z
      .object({
        send_email: z.array(z.object({ name: z.string() })),
        vars: z.record(z.string(), z.unknown()),
      })
      .parse(unstable_readConfig({ config: configPath }));

    const emailSignIn =
      configuration.LOGIN_CODE_DELIVERY === "console" ||
      Boolean(extension.sendEmail) ||
      worker.send_email.some((binding) => binding.name === "EMAIL") ||
      Boolean(worker.vars["EMAIL_FROM"]);

    if (bootstrap.settings || emailSignIn || state.bootstrapPending) {
      const secrets = z.object({ APP_COOKIE_SECRET: z.string().min(1) }).parse(process.env);

      const services = await connectCloudflareSettings(
        configuration,
        database.db,
        configuration.PLATFORM_ENCRYPTION_KEY,
        secrets.APP_COOKIE_SECRET,
        configPath,
        extension,
        observation,
      );

      try {
        await initializeBootstrap(
          services.settings,
          createAuthentication(configuration, database.db, { ...extension, observation }),
          database.db,
          bootstrap,
        );
      } finally {
        await services.close();
      }
    } else {
      await createInstallationOwner(database.db, bootstrap.owner, false, observation);
    }
  }

  console.info("Hosted installation initialized");
} finally {
  await closeObservation(observation);
  await database.close();
}
