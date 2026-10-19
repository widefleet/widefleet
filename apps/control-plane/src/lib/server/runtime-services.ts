import type { FleetAccess } from "./application-context.ts";
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
import type { createCloudflareLogs } from "./cloudflare-logs.ts";
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
  hostedLogs,
  fleetAccess,
}: {
  configuration: Configuration & { BETTER_AUTH_SECRET: string };
  database: ReturnType<typeof createDatabase>;
  settings: ReturnType<typeof createSettingsService>;
  storage: ArtifactStorage;
  reporting: ReturnType<typeof createReporting>;
  encryptionKey: string;
  execution?: HostedExecution;
  fleetAccess?: FleetAccess;
  hostedLogs?: ReturnType<typeof createCloudflareLogs>;
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
    releases: createRuntimeReleaseService(database.db, storage, execution),
    uploads: createUploadService(database.db, storage, configuration, execution),
    telemetry: createTelemetry(database.db, storage, configuration, hostedLogs),
  };

  let current: ReturnType<typeof snapshot> | undefined;
  let previous = "";

  const snapshot = (
    active: typeof configuration,
    ownerId: string | null,
    settingsRevision: number,
  ) => {
    const auth = createAuthentication(active, database.db);

    return {
      ...services,
      configuration: active,
      ownerId,
      settingsRevision,
      auth,
      identity: createIdentityService(auth, database.db, active, fleetAccess),
      directory: createDirectory(active),
    };
  };

  return async (loaded?: Awaited<ReturnType<typeof settings.resolve>>) => {
    const resolved = loaded ?? (await settings.resolve());

    const active = {
      ...configuration,
      IDENTITY: resolved.identity,
      LOCAL_PASSWORD_ENABLED: resolved.state.localPasswordEnabled,
    };

    const fingerprint = JSON.stringify([active.IDENTITY, active.LOCAL_PASSWORD_ENABLED]);

    if (!current || previous !== fingerprint) {
      current = snapshot(active, resolved.state.ownerId, resolved.revision);
      previous = fingerprint;
    }

    if (
      current.ownerId !== resolved.state.ownerId ||
      current.settingsRevision !== resolved.revision
    )
      current = {
        ...current,
        ownerId: resolved.state.ownerId,
        settingsRevision: resolved.revision,
      };

    return current;
  };
};

export type Runtime = Awaited<ReturnType<ReturnType<typeof createRuntime>>>;

// Each HTTP request shares its first read. A settings write in the same process
// invalidates that read, including SvelteKit query refreshes after remote commands.
export const createRequestRuntime = (resolve: () => Promise<Runtime>) => {
  let pending: Promise<Runtime> | undefined;
  let current: Runtime | undefined;

  return () => {
    if (!pending || (current && current.settings.revision !== current.settingsRevision)) {
      current = undefined;
      pending = resolve().then((runtime) => {
        current = runtime;

        return runtime;
      });
    }

    return pending;
  };
};
