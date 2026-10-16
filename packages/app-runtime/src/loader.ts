import { createAuthHandler, manageAuthConfiguration } from "@platform/auth-proxy";
import { authControlPath } from "@platform/auth-proxy/publication";
import { WorkerEntrypoint } from "cloudflare:workers";
import { appEventConfiguration } from "@platform/contracts";
import { publishedApp } from "@platform/contracts";
import { z } from "zod";
import { workflowJson } from "./workflow-json.ts";
import { workflowCatalog } from "./workflow-catalog.ts";
import { workflowRequest } from "@platform/contracts";
import { workerCode } from "./worker.ts";
import { browserPolicy } from "./csp.ts";
import { serveAsset } from "./assets.ts";
import { appKey, readApp } from "./catalog.ts";
import type { WorkflowRunner } from "./workflow-runner.ts";
import type { Events } from "./events.ts";
import type { ParentEnvironment, PublishedApp, Json } from "./types.ts";

export { Database, KeyValue, Producer } from "./storage.ts";

export { Objects } from "./objects.ts";

export { Assets } from "./assets.ts";

export { Gateway } from "./egress.ts";

export { AppWorkflow, WorkflowSessions } from "./workflow-host.ts";

export { CloudflareAppWorkflow, CloudflareWorkflowCatalog } from "./workflow-cloudflare.ts";

export {
  WorkflowBinding,
  WorkflowCatalog as WidefleetWorkflowCatalog,
} from "./workflow-catalog.ts";

export { Telemetry } from "./telemetry.ts";

export { CloudflareTelemetry } from "./telemetry-cloudflare.ts";

const eventConfiguration = async (environment: ParentEnvironment) => {
  const configuration = z
    .union([appEventConfiguration, z.object({ source: z.literal("r2") })])
    .parse(JSON.parse(environment.WIDEFLEET_CONFIGURATION));

  if (!("source" in configuration)) return { events: configuration, concurrency: null };
  const object = await environment.WIDEFLEET_PACKAGES.get("events/configuration.json");

  return {
    events: object
      ? z.object({ configuration: appEventConfiguration }).parse(await object.json()).configuration
      : { crons: {}, queues: {} },
    concurrency: 4,
  };
};

const load = (app: PublishedApp, environment: ParentEnvironment, context: ExecutionContext) =>
  environment.WIDEFLEET_LOADER.get(appKey(app), () => workerCode(app, environment, context));

const run = async <T>(
  app: PublishedApp,
  environment: ParentEnvironment,
  context: ExecutionContext,
  operation: (worker: WorkerStub) => Promise<T>,
) => {
  const worker = load(app, environment, context);

  try {
    return await operation(worker);
  } catch (cause) {
    worker.dispose?.();
    throw cause;
  }
};

const managementRequest = (request: Request, environment: ParentEnvironment) => {
  const token = z.string().min(32).safeParse(environment.WIDEFLEET_CONTROL_TOKEN);

  return token.success && request.headers.get("authorization") === `Bearer ${token.data}`;
};

const dispatchApp = async (
  request: Request,
  environment: ParentEnvironment,
  context: ExecutionContext,
  authenticatedApp: string | null,
) => {
  const url = new URL(request.url);
  const candidate = request.headers.get("x-widefleet-candidate");
  let app;

  if (candidate) {
    const [appId, version] = z
      .tuple([publishedApp.shape.appId, publishedApp.shape.version])
      .parse(candidate.split("/"));

    app = await readApp(environment, `versions/${appId}/${version}.json`);
  } else {
    if (!/^[a-z0-9.-]+$/.test(url.hostname)) return new Response(null, { status: 400 });
    app = await readApp(environment, `hosts/${url.hostname}.json`);
  }

  if (!app) return new Response("App is not published", { status: 404 });

  if (authenticatedApp !== null && authenticatedApp !== app.appId)
    return new Response("App authorization is being updated", { status: 503 });

  if (url.pathname === "/.well-known/widefleet/ready") {
    await run(app, environment, context, (worker) =>
      worker.getEntrypoint<Events>("Events").ready(),
    );

    for (const binding of app.metadata.bindings) {
      if (binding.type !== "workflow") continue;

      const worker = environment.WIDEFLEET_LOADER.load(
        await workerCode(app, environment, context, binding.workflow_name),
      );

      try {
        await worker.getEntrypoint<WorkflowRunner>("WorkflowRunner").ready();
      } finally {
        worker.dispose?.();
      }
    }

    return Response.json({
      deploymentId: app.deploymentId,
      networkRevision: app.network.revision,
      capabilityRevision: app.capabilityRevision,
      version: app.version,
      runtimeVersion: WIDEFLEET_RUNTIME_VERSION,
    });
  }

  if (candidate) return new Response(null, { status: 403 });

  if (request.method === "GET" || request.method === "HEAD") {
    const asset = await serveAsset(request, environment, app);

    if (asset.status !== 404) return browserPolicy(asset, app.network.policy.browser);
  }

  return browserPolicy(
    // celld forwards incoming request cancellation only when the signal is
    // explicitly supplied to the subrequest.
    await run(app, environment, context, (worker) =>
      worker.getEntrypoint().fetch(request, { signal: request.signal }),
    ),
    app.network.policy.browser,
  );
};

const isManagementRequest = (request: Request) =>
  new URL(request.url).pathname.startsWith("/.well-known/widefleet/") ||
  request.headers.has("x-widefleet-candidate");

const manageRuntime = async (
  request: Request,
  environment: ParentEnvironment,
  context: ExecutionContext,
) => {
  const url = new URL(request.url);

  if (url.pathname === "/.well-known/widefleet/runtime") {
    return Response.json({ runtimeVersion: WIDEFLEET_RUNTIME_VERSION });
  }

  if (url.pathname === "/.well-known/widefleet/workflows") {
    if (request.method !== "POST") return new Response(null, { status: 403 });

    try {
      const input = z
        .strictObject({
          appId: z.uuid(),
          hostname: z.string(),
          requestId: z.uuid(),
          request: z.union([workflowRequest, z.strictObject({ action: z.literal("purge") })]),
        })
        .parse(await request.json());

      const catalog = workflowCatalog(environment, input.appId);

      const result =
        input.request.action === "purge"
          ? await catalog.purge()
          : await catalog.manage(
              { appId: input.appId, hostname: input.hostname, workflow: input.request.workflow },
              input.requestId,
              input.request,
            );

      return Response.json({ result: workflowJson(result) });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }

  if (url.pathname === "/.well-known/widefleet/ready") {
    return dispatchApp(request, environment, context, null);
  }

  if (url.pathname.startsWith(`${authControlPath}/`))
    return manageAuthConfiguration(request, environment);

  return new Response(null, { status: 404 });
};

export class RuntimeManagement extends WorkerEntrypoint<ParentEnvironment> {
  override fetch(request: Request) {
    return manageRuntime(request, this.env, this.ctx);
  }
}

export default {
  async fetch(request: Request, environment: ParentEnvironment, context: ExecutionContext) {
    if (isManagementRequest(request)) {
      // Only the private native listener accepts token-authenticated HTTP management.
      // Hosted management is available exclusively through RuntimeManagement.
      if (environment["WIDEFLEET_MANAGEMENT_HTTP"] !== "true")
        return new Response(null, { status: 404 });

      if (!managementRequest(request, environment)) return new Response(null, { status: 403 });

      return manageRuntime(request, environment, context);
    }

    return createAuthHandler(environment, (authenticated, appId) =>
      dispatchApp(authenticated, environment, context, appId),
    ).fetch(request);
  },
  async scheduled(
    controller: ScheduledController,
    environment: ParentEnvironment,
    context: ExecutionContext,
  ) {
    const configuration = await eventConfiguration(environment);
    const hosts = configuration.events.crons[controller.cron] ?? [];
    const concurrency = configuration.concurrency ?? Math.max(hosts.length, 1);

    let failed = false;

    // Workers allow four distinct in-flight Dynamic Workers per request.
    for (let offset = 0; offset < hosts.length; offset += concurrency) {
      const results = await Promise.allSettled(
        hosts.slice(offset, offset + concurrency).map(async (host) => {
          const app = await readApp(environment, `hosts/${host}.json`);

          if (!app || !app.metadata.crons.includes(controller.cron)) return;

          const result = await run(app, environment, context, (worker) =>
            worker
              .getEntrypoint<Events>("Events")
              .runScheduled({ cron: controller.cron, scheduledTime: controller.scheduledTime }),
          );

          if (result.error && !result.noRetry) throw new Error(result.error);
        }),
      );

      failed ||= results.some((result) => result.status === "rejected");
    }

    if (failed) throw new Error("App cron delivery failed");
  },

  async queue(
    batch: MessageBatch<Json | ArrayBuffer>,
    environment: ParentEnvironment,
    context: ExecutionContext,
  ) {
    const target = (await eventConfiguration(environment)).events.queues[batch.queue];

    if (!target) throw new Error("Queue has no application consumer");
    const app = await readApp(environment, `hosts/${target.hostname}.json`);

    if (!app || !app.metadata.queue_consumers.some((consumer) => consumer.queue === target.queue))
      throw new Error("Queue consumer is not published");

    const result = await run(app, environment, context, (worker) =>
      worker.getEntrypoint<Events>("Events").runQueue({
        queue: target.queue,
        metadata: batch.metadata,
        messages: batch.messages.map((message) => ({
          id: message.id,
          body: message.body,
          timestamp: message.timestamp,
          attempts: message.attempts,
        })),
      }),
    );

    const messages = new Map(batch.messages.map((message) => [message.id, message]));

    for (const decision of result.decisions) {
      const message = messages.get(decision.id);

      if (decision.action === "ack") message?.ack();
      else message?.retry(decision.options);
    }

    if (result.error) throw new Error(result.error);
  },
};
