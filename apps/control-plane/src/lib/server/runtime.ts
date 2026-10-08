import { migrate } from "drizzle-orm/node-postgres/migrator";
import { initializeEdge } from "./edge.ts";
import { resolve } from "node:path";
import { createAuthentication, registerCli } from "./auth.ts";
import { readConfiguration } from "./config.ts";
import { createDatabase } from "./database.ts";
import { createIdentityService } from "./identity.ts";
import { createStorage } from "./storage.ts";
import { createAppService } from "./apps.ts";
import { createAgentService } from "./agents.ts";
import { createRuntimeReleaseService } from "./runtime-releases.ts";
import { createConnectorService } from "./connectors.ts";
import { createAppAccessService } from "./app-access.ts";
import { createNetworkService } from "./network.ts";
import { createWorkflowService } from "./workflows.ts";
import { createMigrationService } from "./migrations.ts";
import { createJobService } from "./jobs.ts";
import { createUploadService } from "./uploads.ts";
import { createReporting } from "./reporting.ts";
import { createTelemetry } from "./telemetry.ts";
import { createDirectory } from "./directory.ts";
import { installationKeys } from "./installation-files.ts";
import {
  createInstallationOwner,
  initializeInstallation,
  readBootstrap,
  readInstallation,
} from "./installation-store.ts";
import { initializeOrganization } from "./organization.ts";
import { createSettingsService } from "./settings.ts";

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

const createRuntime = async () => {
  const { configuration, database, settings, encryptionKey } = await initializeRuntime();
  const storage = createStorage(configuration);

  const reporting = createReporting(
    configuration,
    database.db,
    fetch,
    async () => (await settings.resolve()).identity,
  );

  reporting.start();
  process.once("uncaughtException", (error) => {
    console.error("Control plane stopped after an uncaught exception", error);
    reporting.exception(error);
    void reporting.close().finally(() => process.exit(1));
  });

  process.once("sveltekit:shutdown", () => {
    void reporting
      .close()
      .then(() => database.close())
      .catch((cause: unknown) => console.error("Database shutdown failed", cause));
  });

  const services = {
    configuration,
    database,
    settings,
    reporting,
    storage,
    agents: createAgentService(database.db),
    jobs: createJobService(database.db, storage, encryptionKey, reporting.operation),
    network: createNetworkService(database.db),
    workflows: createWorkflowService(database.db),
    migrations: createMigrationService(database.db, storage),
    connectors: createConnectorService(database.db, storage, encryptionKey),
    releases: createRuntimeReleaseService(database.db, storage),
    uploads: createUploadService(database.db, storage, configuration),
    telemetry: createTelemetry(database.db, storage, configuration),
  };

  let current: ReturnType<typeof snapshot> | undefined;
  let previous = "";

  const snapshot = (active: typeof configuration) => {
    const auth = createAuthentication(active, database.db);

    return {
      ...services,
      configuration: active,
      auth,
      apps: createAppService(database.db, active),
      appAccess: createAppAccessService(database.db, active),
      identity: createIdentityService(auth, database.db, active),
      directory: createDirectory(active),
    };
  };

  return async () => {
    const resolved = await settings.resolve();

    const active = {
      ...configuration,
      IDENTITY: resolved.identity,
      LOCAL_PASSWORD_ENABLED: resolved.state.localPasswordEnabled,
    };

    const fingerprint = JSON.stringify([active.IDENTITY, active.LOCAL_PASSWORD_ENABLED]);

    if (!current || previous !== fingerprint) {
      current = snapshot(active);
      previous = fingerprint;
    }

    return current;
  };
};

export type Runtime = Awaited<ReturnType<Awaited<ReturnType<typeof createRuntime>>>>;

let runtime: ReturnType<typeof createRuntime> | undefined;

export const getRuntime = async () => {
  runtime ??= createRuntime();

  return (await runtime)();
};
