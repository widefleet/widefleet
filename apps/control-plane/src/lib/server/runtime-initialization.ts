import { organizationIdentifier } from "@platform/contracts";
import { createAppSignIn } from "./app-sign-in-node.ts";
import { bootstrapConfiguration } from "@platform/contracts";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { join, resolve } from "node:path";
import { initializeBootstrap } from "./bootstrap.ts";
import { migrateSsoSettings } from "./sso-migration.ts";
import { createAuthentication, registerCli } from "./auth.ts";
import { readConfiguration, type Configuration } from "./config.ts";
import { createDatabase } from "./database.ts";
import { initializeEdge } from "./edge.ts";
import {
  installationKeys,
  persistentKey,
  readOptionalFile,
  writePrivateFile,
} from "./installation-files.ts";
import { initializeInstallation, readInstallation } from "./installation-store.ts";
import { initializeOrganization } from "./organization.ts";
import { createSettingsService } from "./settings.ts";
import { installationRuntime } from "./organization-runtime.ts";
import { z } from "zod";

const readBootstrap = async (configuration: Configuration) => {
  if (!configuration.PLATFORM_BOOTSTRAP_FILE) return null;
  const source = await readOptionalFile(configuration.PLATFORM_BOOTSTRAP_FILE);

  if (source === null) throw new Error("The configured bootstrap file could not be read");

  return bootstrapConfiguration.parse(JSON.parse(source));
};

export const prepareInstallation = async (
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
    await migrateSsoSettings(database.db, keys.encryption);

    const execution = await database.db.transaction(installationRuntime);
    const path = join(configuration.PLATFORM_RUNTIME_DIRECTORY, "installation.json");
    const existing = await readOptionalFile(path);

    const controlToken = await persistentKey(
      configuration.PLATFORM_RUNTIME_DIRECTORY,
      "control-token",
    );

    if (existing !== null) {
      const installed = z
        .object({ organizationId: organizationIdentifier, controlToken: z.string() })
        .parse(JSON.parse(existing));

      if (
        installed.organizationId !== execution.organizationId ||
        installed.controlToken !== controlToken
      )
        throw new Error("Runtime configuration belongs to a different installation");
    } else {
      await writePrivateFile(
        path,
        JSON.stringify({ organizationId: execution.organizationId, controlToken }),
      );
    }

    return { keys, configuration, database };
  } catch (cause) {
    await database.close();
    throw cause;
  }
};

export const initializeRuntime = async (
  input = readConfiguration(),
  migrationsFolder = resolve("migrations"),
) => {
  const { keys, configuration, database } = await prepareInstallation(input, migrationsFolder);

  try {
    const settings = createSettingsService(
      configuration,
      database.db,
      keys.encryption,
      (organizationId) => createAppSignIn(configuration, keys.cookie, organizationId),
    );

    const state = await readInstallation(database.db);

    if (!state.ownerId) {
      const bootstrap = await readBootstrap(configuration);

      if (bootstrap) {
        await initializeBootstrap(
          settings,
          createAuthentication(
            { ...configuration, LOCAL_PASSWORD_ENABLED: state.localPasswordEnabled },
            database.db,
            { encryptionKey: keys.encryption },
          ),
          bootstrap,
        );
      }
    }

    await registerCli(database.db, configuration);

    return { configuration, database, settings, encryptionKey: keys.encryption };
  } catch (cause) {
    await database.close();
    throw cause;
  }
};
