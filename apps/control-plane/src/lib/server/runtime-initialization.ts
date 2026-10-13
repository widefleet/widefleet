import { bootstrapConfiguration } from "@platform/contracts";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { resolve } from "node:path";
import { createAuthentication, registerCli } from "./auth.ts";
import { readConfiguration, type Configuration } from "./config.ts";
import { createDatabase } from "./database.ts";
import { initializeEdge } from "./edge.ts";
import { installationKeys, readOptionalFile } from "./installation-files.ts";
import {
  createInstallationOwner,
  initializeInstallation,
  readInstallation,
} from "./installation-store.ts";
import { initializeOrganization } from "./organization.ts";
import { createSettingsService } from "./settings.ts";

const readBootstrap = async (configuration: Configuration) => {
  if (!configuration.PLATFORM_BOOTSTRAP_FILE) return null;
  const source = await readOptionalFile(configuration.PLATFORM_BOOTSTRAP_FILE);

  if (source === null) throw new Error("The configured bootstrap file could not be read");

  return bootstrapConfiguration.parse(JSON.parse(source));
};

export const initializeRuntime = async (
  input = readConfiguration(),
  migrationsFolder = resolve("migrations"),
) => {
  const keys = await installationKeys(input);
  const configuration = { ...input, BETTER_AUTH_SECRET: keys.authentication };
  await initializeEdge(configuration);
  const database = createDatabase(configuration);

  try {
    await migrate(database.db, { migrationsFolder });
    await initializeOrganization(database.db);
    await initializeInstallation(database.db);

    const settings = createSettingsService(
      configuration,
      database.db,
      keys.encryption,
      keys.cookie,
    );

    const state = await readInstallation(database.db);

    if (!state.ownerId) {
      const bootstrap = await readBootstrap(configuration);

      if (bootstrap) {
        if (bootstrap.settings) await settings.initialize(bootstrap.settings);
        await createInstallationOwner(database.db, bootstrap.owner);
      }
    }

    await registerCli(createAuthentication(configuration, database.db), database.db, configuration);

    return { configuration, database, settings, encryptionKey: keys.encryption };
  } catch (cause) {
    await database.close();
    throw cause;
  }
};
