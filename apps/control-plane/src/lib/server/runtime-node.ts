import { getRequestEvent } from "$app/server";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { initializeRuntime } from "./runtime-initialization.ts";
import { createReporting } from "./reporting.ts";
import { createRuntime } from "./runtime-services.ts";
import { createStorage } from "./storage.ts";

export type { Runtime } from "./runtime-services.ts";

const startRuntime = async () => {
  const { configuration, database, settings, encryptionKey, extension } = await initializeRuntime();
  const storage = createStorage(configuration);

  const reporting = createReporting(configuration, database.db);

  reporting.start();
  process.once("uncaughtException", (error) => {
    console.error("Control plane stopped after an uncaught exception", error);
    reporting.exception(error);
    void reporting.close().finally(() => process.exit(1));
  });

  process.once("sveltekit:shutdown", () => {
    void Promise.allSettled([reporting.close(), extension.observation?.close()])
      .then(() => database.close())
      .catch((cause: unknown) => console.error("Database shutdown failed", cause));
  });

  return createRuntime({
    ...extension,
    configuration,
    database,
    settings,
    storage,
    reporting,
    encryptionKey,
    authCookies: sveltekitCookies(getRequestEvent),
  });
};

let runtime: ReturnType<typeof startRuntime> | undefined;

export const getRuntime = async () => {
  runtime ??= startRuntime();

  return (await runtime)();
};
