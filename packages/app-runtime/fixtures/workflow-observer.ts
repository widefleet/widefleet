import { z } from "zod";
import {
  publishedApp,
  workflowRequest,
  organizationHttpAvailabilityKey,
} from "@platform/contracts";
import { CloudflareWorkflowCatalog } from "../src/workflow-cloudflare.ts";
import type { ParentEnvironment } from "../src/types.ts";
import type { Start } from "../src/workflow-protocol.ts";

export * from "../src/loader.ts";

export class Catalog extends CloudflareWorkflowCatalog {
  constructor(state: DurableObjectState, environment: ParentEnvironment) {
    super(state, {
      ...environment,
      WIDEFLEET_WORKFLOWS: {
        get: environment.WIDEFLEET_WORKFLOWS.get.bind(environment.WIDEFLEET_WORKFLOWS),
        deleteBatch: environment.WIDEFLEET_WORKFLOWS.deleteBatch.bind(
          environment.WIDEFLEET_WORKFLOWS,
        ),
        createBatch: environment.WIDEFLEET_WORKFLOWS.createBatch.bind(
          environment.WIDEFLEET_WORKFLOWS,
        ),
        async create(options?: WorkflowInstanceCreateOptions<Start>) {
          const { mode } = z.object({ mode: z.string() }).parse(options?.params?.params);

          if (mode === "missing") throw new Error("Synthetic create response lost");
          const instance = await environment.WIDEFLEET_WORKFLOWS.create(options);

          if (mode === "ambiguous") throw new Error("Synthetic create response lost");

          return instance;
        },
      },
    });
  }
}

export default {
  async fetch(request: Request, environment: ParentEnvironment) {
    const app = publishedApp.parse(JSON.parse(z.string().parse(environment["APP"])));

    const catalog = environment.WIDEFLEET_WORKFLOW_CATALOG.get(
      environment.WIDEFLEET_WORKFLOW_CATALOG.idFromName(app.appId),
    );

    const scope = { appId: app.appId, hostname: app.hostname, workflow: "example" };
    const path = new URL(request.url).pathname;

    if (path === "/publish") {
      const source = await request.text();
      await environment.WIDEFLEET_PACKAGES.put(`hosts/${app.hostname}.json`, JSON.stringify(app));
      await environment.WIDEFLEET_PACKAGES.put(
        `versions/${app.appId}/${app.version}.json`,
        JSON.stringify(app),
      );
      await environment.WIDEFLEET_PACKAGES.put(
        `apps/${app.appId}/modules/${app.modules[0]?.sha256}`,
        source,
      );
      await environment.AUTH_CONFIG.put(
        `apps/${app.hostname}`,
        JSON.stringify({
          organizationId: "fixture",
          appId: app.appId,
          access: { revision: 0, groups: [] },
        }),
      );

      return new Response(null, { status: 204 });
    }

    if (path === "/availability") {
      await environment.AUTH_CONFIG.put(
        organizationHttpAvailabilityKey("fixture"),
        await request.text(),
      );

      return new Response(null, { status: 204 });
    }

    try {
      if (path === "/batch") {
        const ids = z.array(z.string()).parse(await request.json());

        return Response.json(
          await catalog.createBatch(
            scope,
            ids.map((id) => ({ id, params: { mode: "quick" } })),
          ),
        );
      }

      const operation = workflowRequest.parse(await request.json());

      const result = await catalog.manage(
        scope,
        request.headers.get("x-request-id") ?? crypto.randomUUID(),
        operation,
      );

      return Response.json({ result });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  },
};
