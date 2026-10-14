import { createAuthentication } from "./auth.ts";
import { createIdentityService } from "./identity.ts";
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
import { createTelemetry } from "./telemetry.ts";
import { createDirectory } from "./directory.ts";
import type { Configuration } from "./config.ts";
import type { createDatabase } from "./database.ts";
import type { createReporting } from "./reporting.ts";
import type { createSettingsService } from "./settings.ts";
import type { ArtifactStorage } from "./storage.ts";
import type { HostedExecution } from "./deployment-execution.ts";

export const createRuntime = ({
  configuration,
  database,
  settings,
  storage,
  reporting,
  encryptionKey,
  execution,
}: {
  configuration: Configuration & { BETTER_AUTH_SECRET: string };
  database: ReturnType<typeof createDatabase>;
  settings: ReturnType<typeof createSettingsService>;
  storage: ArtifactStorage;
  reporting: ReturnType<typeof createReporting>;
  encryptionKey: string;
  execution?: HostedExecution;
}) => {
  const services = {
    configuration,
    database,
    settings,
    reporting,
    storage,
    apps: createAppService(database.db, configuration, execution),
    agents: createAgentService(database.db),
    jobs: createJobService(database.db, storage, encryptionKey, reporting.operation),
    network: createNetworkService(database.db, execution),
    appAccess: createAppAccessService(database.db, execution),
    workflows: createWorkflowService(database.db, execution),
    migrations: createMigrationService(database.db, storage, execution),
    connectors: createConnectorService(database.db, storage, encryptionKey, execution),
    releases: createRuntimeReleaseService(database.db, storage),
    uploads: createUploadService(database.db, storage, configuration, execution),
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

export type Runtime = Awaited<ReturnType<ReturnType<typeof createRuntime>>>;
