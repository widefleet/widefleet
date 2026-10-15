import { error } from "@sveltejs/kit";
import { createArtifactStorage } from "./artifact-storage.ts";
import { readCloudflareConfiguration, type CloudflareBindings } from "./cloudflare-config.ts";
import { createDatabase } from "./database.ts";
import { readInstallation } from "./installation-store.ts";
import { createReporting } from "./reporting.ts";
import { createRuntime } from "./runtime-services.ts";
import { createSettingsService } from "./settings.ts";
import { createR2Storage } from "./storage/r2.ts";
import { createCloudflareLogs } from "./cloudflare-logs.ts";
import { createCloudflareExecution } from "./cloudflare-execution.ts";

export const createCloudflareRuntime = (bindings: CloudflareBindings) => {
  const configuration = readCloudflareConfiguration(bindings);
  // A pool belongs to this request only; Hyperdrive owns pooling between requests.
  const database = createDatabase(configuration, 5);

  const settings = createSettingsService(
    configuration,
    database.db,
    configuration.PLATFORM_ENCRYPTION_KEY,
    null,
  );

  const reporting = createReporting(
    configuration,
    database.db,
    fetch,
    async () => (await settings.resolve()).identity,
  );

  const storage = createArtifactStorage(createR2Storage(bindings.ARTIFACTS));

  const resolve = createRuntime({
    configuration,
    database,
    settings,
    storage,
    execution: createCloudflareExecution(bindings, database.db, storage),
    hostedLogs: createCloudflareLogs(bindings),
    reporting,
    encryptionKey: configuration.PLATFORM_ENCRYPTION_KEY,
  });

  let initialized: Promise<void> | undefined;

  const verifyInstallation = async () => {
    if (!(await readInstallation(database.db)).ownerId)
      error(503, "Initialize the hosted installation before accepting requests");
  };

  return {
    get: async () => {
      initialized ??= verifyInstallation();
      await initialized;
      const runtime = await resolve();
      await runtime.auth.$context;

      return runtime;
    },
    close: async () => {
      try {
        await reporting.close();
      } finally {
        await database.close();
      }
    },
  };
};
