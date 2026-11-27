import { AsyncLocalStorage } from "node:async_hooks";
import { tracing } from "cloudflare:workers";
import { userConnectionControlPath } from "@platform/contracts";
import { createProductAnalytics } from "./analytics.ts";
import { getRequestEvent } from "$app/server";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { createRuntimeExtension } from "#runtime-extension";
import { createCloudflareEmail } from "./email-cloudflare.ts";
import { createArtifactStorage } from "./artifact-storage.ts";
import { readCloudflareConfiguration, type CloudflareBindings } from "./cloudflare-config.ts";
import { createDatabase, type Database } from "./database.ts";
import type { Observation } from "./observation.ts";
import { createReporting } from "./reporting.ts";
import { createRuntime, createRequestRuntime } from "./runtime-services.ts";
import { createSettingsService } from "./settings.ts";
import { configuredSecretEncryption } from "./secret-encryption.ts";
import { createR2Storage } from "./storage/r2.ts";
import { createCloudflareLogs } from "./cloudflare-logs.ts";
import { createCloudflareExecution } from "./cloudflare-execution.ts";
import { createCloudflareAppSignIn } from "./app-sign-in-cloudflare.ts";
import { cloudflareAuthRateLimit } from "./auth-rate-limit-cloudflare.ts";
import { bindingAppBuilder } from "./app-builder.ts";

// Workers forbid I/O on behalf of another request, so each request opens its own database pool
// and its own analytics and reporting clients. Everything else is built once per isolate.
type RequestServices = {
  database: ReturnType<typeof createDatabase>;
  observation: ReturnType<typeof createProductAnalytics>;
  reporting: ReturnType<typeof createReporting>;
};

const requests = new AsyncLocalStorage<RequestServices>();

const current = () => {
  const services = requests.getStore();

  if (!services) throw new Error("The control plane runtime was used outside a request");

  return services;
};

// The shared runtime keeps these objects; each call reaches the current request's instance.
// SAFETY: The proxy forwards every property of the request's Drizzle instance, binding methods
// to it, so it behaves as that instance for the duration of each call.
const database = new Proxy({} as Database, {
  get: (_target, property) => {
    const db = current().database.db;
    // SAFETY: `property` is read from the same Drizzle instance the proxy stands for.
    const value: unknown = db[property as keyof Database];

    const forwarded: unknown = value instanceof Function ? value.bind(db) : value;

    return forwarded;
  },
});

const observation: Observation = {
  capture: (event) => current().observation.capture(event),
  exception: (error, distinctId, properties) =>
    current().observation.exception(error, distinctId, properties),
  alias: (userId, aliases) => current().observation.alias(userId, aliases),
  close: () => current().observation.close(),
};

const reporting: ReturnType<typeof createReporting> = {
  start: () => current().reporting.start(),
  status: () => current().reporting.status(),
  read: (principal) => current().reporting.read(principal),
  update: (principal, preferences) => current().reporting.update(principal, preferences),
  preview: (principal) => current().reporting.preview(principal),
  active: (id) => current().reporting.active(id),
  exception: (error) => current().reporting.exception(error),
  browser: (report) => current().reporting.browser(report),
  agent: (report) => current().reporting.agent(report),
  operation: (report) => current().reporting.operation(report),
  flush: () => current().reporting.flush(),
  close: () => current().reporting.close(),
};

const createSharedRuntime = (
  bindings: CloudflareBindings,
  configuration: ReturnType<typeof readCloudflareConfiguration>,
) => {
  const extension = createRuntimeExtension({
    database,
    configuration,
    observation,
    binding: (name, schema) => schema.parse(bindings[name]),
  });

  const sendEmail = extension.sendEmail ?? createCloudflareEmail(bindings);

  const encryption = configuredSecretEncryption(configuration);

  const settings = createSettingsService(
    configuration,
    database,
    encryption,
    (organizationId) => createCloudflareAppSignIn(configuration, bindings, organizationId),
    Boolean(sendEmail),
    observation,
  );

  const storage = createArtifactStorage(createR2Storage(bindings.ARTIFACTS));

  const options: Parameters<typeof createRuntime>[0] = {
    userConnectionRequest: async (input, signal) => {
      if (!bindings.APP_RUNTIME) throw new Error("App runtime management binding is missing");

      return bindings.APP_RUNTIME.fetch(`https://runtime.invalid${userConnectionControlPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        // SAFETY: Both environments provide the Web AbortSignal implementation.
        signal: (signal ??
          AbortSignal.timeout(15_000)) as import("@cloudflare/workers-types").AbortSignal,
      });
    },
    discoveryTransport: "cloudflare",
    ...extension,
    observation,
    configuration,
    // The runtime closes nothing itself; each request closes its own pool.
    database: { db: database, close: async () => {} },
    settings,
    storage,
    execution: createCloudflareExecution(bindings, database, storage),
    hostedLogs: createCloudflareLogs(bindings),
    reporting,
    encryption,
    authRateLimit: cloudflareAuthRateLimit(bindings, configuration.PLATFORM_URL),
    authIpAddressHeaders: ["cf-connecting-ip"],
    // Isolates start often at low traffic, and the check would run on each start. Node keeps it,
    // so tests still compare Better Auth's expected schema with ours.
    authValidateSchema: false,
    authCookies: sveltekitCookies(getRequestEvent),
  };

  if (sendEmail) options.sendEmail = sendEmail;

  const { APP_CI: ci, BUILDS: builds } = bindings;

  if (ci && builds)
    options.startBuild = async (id) => {
      await builds.create({ id, params: { id } });
    };

  if (bindings.APP_BUILDER && bindings.APP_DOCUMENTER)
    options.builder = bindingAppBuilder(bindings.APP_BUILDER, bindings.APP_DOCUMENTER);

  return createRequestRuntime(createRuntime(options));
};

let shared: ReturnType<typeof createSharedRuntime> | undefined;

export const createCloudflareRuntime = (bindings: CloudflareBindings) => {
  // Hyperdrive exposes its connection string only inside a request handler.
  const configuration = readCloudflareConfiguration(bindings);

  // A pool belongs to this request only; Hyperdrive owns pooling between requests.
  const requestDatabase = createDatabase(configuration, 5, (name, attributes) => {
    // Hyperdrive connections are TCP sockets, which automatic tracing does not show.
    const span = tracing.startSpan(name).setAttributes(attributes);

    return (failure) => {
      if (failure) span.setAttribute("error.type", failure.type).setStatus({ code: "error" });
      span.end();
    };
  });

  const requestObservation = createProductAnalytics(configuration);
  requestDatabase.db.$client.on("error", (error) => requestObservation.exception(error));

  const services: RequestServices = {
    database: requestDatabase,
    observation: requestObservation,
    reporting: createReporting(configuration, requestDatabase.db),
  };

  return {
    // Runs request handling with this request's services behind the shared runtime.
    run: <T>(handler: () => T) => requests.run(services, handler),
    // Building the runtime starts Better Auth's initialization, whose plugins can read the
    // database. It therefore runs in this request's scope too, wherever it is first awaited.
    get: () =>
      requests.run(services, async () => {
        const runtime = (shared ??= createSharedRuntime(bindings, configuration));

        try {
          return await runtime();
        } catch (error) {
          // A failed initialization is retried by the next request instead of being kept.
          if (shared === runtime) shared = undefined;
          throw error;
        }
      }),
    close: async () => {
      try {
        await Promise.allSettled([services.reporting.close(), services.observation.close()]);
      } finally {
        await services.database.close();
      }
    },
  };
};
