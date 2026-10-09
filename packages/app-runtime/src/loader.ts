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

export {
  WorkflowBinding,
  WorkflowCatalog as WidefleetWorkflowCatalog,
} from "./workflow-catalog.ts";

export { Telemetry } from "./telemetry.ts";

const configuration = z.object({
  crons: z.record(z.string(), z.array(z.string())),
  queues: z.record(z.string(), z.object({ hostname: z.string(), queue: z.string() })),
});

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
    worker.dispose();
    throw cause;
  }
};

export default {
  async fetch(request: Request, environment: ParentEnvironment, context: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/widefleet/runtime") {
      if (request.headers.get("authorization") !== `Bearer ${environment.WIDEFLEET_CONTROL_TOKEN}`)
        return new Response(null, { status: 403 });

      return Response.json({ runtimeVersion: WIDEFLEET_RUNTIME_VERSION });
    }

    if (url.pathname === "/.well-known/widefleet/workflows") {
      if (
        request.method !== "POST" ||
        request.headers.get("authorization") !== `Bearer ${environment.WIDEFLEET_CONTROL_TOKEN}`
      )
        return new Response(null, { status: 403 });

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

    const candidate = request.headers.get("x-widefleet-candidate");
    let app;

    if (candidate) {
      if (request.headers.get("authorization") !== `Bearer ${environment.WIDEFLEET_CONTROL_TOKEN}`)
        return new Response(null, { status: 403 });

      const [appId, version] = z
        .tuple([publishedApp.shape.appId, publishedApp.shape.version])
        .parse(candidate.split("/"));

      app = await readApp(environment, `versions/${appId}/${version}.json`);
    } else {
      if (!/^[a-z0-9.-]+$/.test(url.hostname)) return new Response(null, { status: 400 });
      app = await readApp(environment, `hosts/${url.hostname}.json`);
    }

    if (!app) return new Response("App is not published", { status: 404 });

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
          worker.dispose();
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
  },
  async scheduled(
    controller: ScheduledController,
    environment: ParentEnvironment,
    context: ExecutionContext,
  ) {
    const hosts =
      configuration.parse(JSON.parse(environment.WIDEFLEET_CONFIGURATION)).crons[controller.cron] ??
      [];

    const results = await Promise.allSettled(
      hosts.map(async (host) => {
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

    if (results.some((result) => result.status === "rejected"))
      throw new Error("App cron delivery failed");
  },
  async queue(
    batch: MessageBatch<Json | ArrayBuffer>,
    environment: ParentEnvironment,
    context: ExecutionContext,
  ) {
    const target = configuration.parse(JSON.parse(environment.WIDEFLEET_CONFIGURATION)).queues[
      batch.queue
    ];

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
