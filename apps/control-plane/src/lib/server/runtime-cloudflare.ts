import { createProductAnalytics } from "./analytics.ts";
import { getRequestEvent } from "$app/server";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { createRuntimeExtension } from "#runtime-extension";
import { createCloudflareEmail } from "./email-cloudflare.ts";
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
import { cloudflareAuthRateLimit } from "./auth-rate-limit-cloudflare.ts";

export const createCloudflareRuntime = (bindings: CloudflareBindings) => {
  // Hyperdrive exposes its connection string only inside a request handler.
  const configuration = readCloudflareConfiguration(bindings);
  // A pool belongs to this request only; Hyperdrive owns pooling between requests.
  const database = createDatabase(configuration, 5);
  const observation = createProductAnalytics(configuration);
  const reporting = createReporting(configuration, database.db);

  const extension = createRuntimeExtension({
    database: database.db,
    configuration,
    observation,
    binding: (name, schema) => schema.parse(bindings[name]),
  });

  const sendEmail = extension.sendEmail ?? createCloudflareEmail(bindings);

  const settings = createSettingsService(
    configuration,
    database.db,
    configuration.PLATFORM_ENCRYPTION_KEY,
    (organizationId) => createCloudflareAppSignIn(configuration, bindings, organizationId),
    Boolean(sendEmail),
    observation,
  );

  const storage = createArtifactStorage(createR2Storage(bindings.ARTIFACTS));

  const options: Parameters<typeof createRuntime>[0] = {
    discoveryTransport: "cloudflare",
    ...extension,
    observation,
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
    authCookies: sveltekitCookies(getRequestEvent),
  };

  if (sendEmail) options.sendEmail = sendEmail;

  const get = createRequestRuntime(createRuntime(options));

  return {
    get,
    close: async () => {
      try {
        await Promise.allSettled([reporting.close(), observation.close()]);
      } finally {
        await database.close();
      }
    },
  };
};
