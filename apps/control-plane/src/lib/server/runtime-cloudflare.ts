import { createCloudflareEmail } from "./email-cloudflare.ts";
import { cloudflareAuthRateLimit } from "./auth-rate-limit-cloudflare.ts";
import { error } from "@sveltejs/kit";
import { createArtifactStorage } from "./artifact-storage.ts";
import { readCloudflareConfiguration, type CloudflareBindings } from "./cloudflare-config.ts";
import { createDatabase } from "./database.ts";
import { createReporting } from "./reporting.ts";
import { createRuntime, createRequestRuntime } from "./runtime-services.ts";
import { createSettingsService } from "./settings.ts";
import { createR2Storage } from "./storage/r2.ts";
import { createCloudflareLogs } from "./cloudflare-logs.ts";
import { createCloudflareExecution } from "./cloudflare-execution.ts";
import { createCloudflareAppSignIn } from "./app-sign-in-cloudflare.ts";

export const createCloudflareRuntime = (bindings: CloudflareBindings) => {
  const configuration = readCloudflareConfiguration(bindings);
  // A pool belongs to this request only; Hyperdrive owns pooling between requests.
  const database = createDatabase(configuration, 5);

  const settings = createSettingsService(
    configuration,
    database.db,
    configuration.PLATFORM_ENCRYPTION_KEY,
    createCloudflareAppSignIn(configuration, bindings),
  );

  const reporting = createReporting(configuration, database.db);

  const storage = createArtifactStorage(createR2Storage(bindings.ARTIFACTS));

  const sendEmail = createCloudflareEmail(bindings);

  const options: Parameters<typeof createRuntime>[0] = {
    configuration,
    database,
    settings,
    storage,
    execution: createCloudflareExecution(bindings, database.db, storage),
    hostedLogs: createCloudflareLogs(bindings),
    reporting,
    encryptionKey: configuration.PLATFORM_ENCRYPTION_KEY,
    authRateLimit: cloudflareAuthRateLimit(bindings, configuration.PLATFORM_URL),
    authIpAddressHeaders: ["cf-connecting-ip"],
  };

  if (sendEmail) options.sendEmail = sendEmail;
  const resolve = createRuntime(options);

  return {
    get: createRequestRuntime(async () => {
      const installed = await settings.resolve();

      if (!installed.state.ownerId)
        error(503, "Initialize the hosted installation before accepting requests");
      const runtime = await resolve(installed);
      await runtime.auth.$context;

      return runtime;
    }),
    close: async () => {
      try {
        await reporting.close();
      } finally {
        await database.close();
      }
    },
  };
};
