import { userConnectionControlPath } from "@platform/contracts";
import { runtimeManagementRequest } from "./runtime-management-node.ts";
import { getRequestEvent } from "$app/server";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { initializeRuntime } from "./runtime-initialization.ts";
import { createReporting } from "./reporting.ts";
import { createRuntime, type Runtime } from "./runtime-services.ts";
import { httpAppBuilder } from "./app-builder.ts";
import { loadBundledRuntime } from "./bundled-runtime.ts";
import { createStorage } from "./storage.ts";
import { createProductAnalytics } from "./analytics.ts";
import { analyticsEnvironmentSchema } from "../analytics-config.ts";
import { runtimeConfigurationSchema } from "./config.ts";

export type { Runtime } from "./runtime-services.ts";

const startRuntime = async () => {
  const { configuration, database, settings, encryptionKey, extension, observation } =
    await initializeRuntime();

  const storage = createStorage(configuration);

  const reporting = createReporting(configuration, database.db);

  reporting.start();
  process.once("uncaughtException", (error) => {
    console.error("Control plane stopped after an uncaught exception", error);
    reporting.exception(error);
    observation.exception(error);
    void Promise.allSettled([reporting.close(), observation.close()]).finally(() =>
      process.exit(1),
    );
  });

  process.once("sveltekit:shutdown", () => {
    void Promise.allSettled([reporting.close(), observation.close()])
      .then(() => database.close())
      .catch((cause: unknown) => console.error("Database shutdown failed", cause));
  });

  const options: Parameters<typeof createRuntime>[0] = {
    ...extension,
    observation,
    configuration,
    database,
    settings,
    storage,
    reporting,
    encryptionKey,
    userConnectionRequest: (input, signal) =>
      runtimeManagementRequest(
        configuration,
        userConnectionControlPath,
        "POST",
        JSON.stringify(input),
        signal,
      ),
    authCookies: sveltekitCookies(getRequestEvent),
    bundledRuntime: loadBundledRuntime,
  };

  if (configuration.PLATFORM_APP_BUILDER_URL)
    options.builder = httpAppBuilder(configuration.PLATFORM_APP_BUILDER_URL);

  return createRuntime(options);
};

let runtime: Promise<Runtime> | undefined;

export const getRuntime = async () => {
  runtime ??= startRuntime()
    .then((resolve) => resolve())
    .catch(async (cause: unknown) => {
      try {
        const observation = createProductAnalytics({
          ...analyticsEnvironmentSchema.parse(process.env),
          PLATFORM_URL: runtimeConfigurationSchema.shape.PLATFORM_URL.parse(
            process.env["PLATFORM_URL"],
          ),
        });

        observation.exception(cause instanceof Error ? cause : new Error(String(cause)));
        await observation.close();
      } catch {
        // Invalid analytics configuration must not replace the initialization error.
      }

      throw cause;
    });

  return runtime;
};
