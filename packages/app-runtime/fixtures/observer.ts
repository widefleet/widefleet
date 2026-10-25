import { z } from "zod";
import { workerTails } from "../src/worker-definition.ts";
import type { ParentEnvironment } from "../src/types.ts";

export { RuntimeObserver } from "../src/runtime-observer.ts";

export { Telemetry } from "../src/telemetry.ts";

export { CloudflareTelemetry } from "../src/telemetry-cloudflare.ts";

const app = {
  appId: "a0000000-0000-4000-8000-000000000001",
  deploymentId: "a0000000-0000-4000-8000-000000000002",
  buildId: null,
};

const connector = {
  organizationId: "observer-fixture",
  connector: "fixture",
  connectorVersion: "a0000000-0000-4000-8000-000000000003",
};

export default {
  async fetch(request, env, ctx) {
    const scope = new URL(request.url).pathname === "/connector" ? "connector" : "app";

    const worker = env.WIDEFLEET_LOADER.get(scope, () => ({
      mainModule: "child.js",
      compatibilityDate: "2026-10-01",
      modules: {
        "child.js": `export default {
          fetch(request, env) {
            console.log('observer fixture log');
            return Response.json(Object.keys(env));
          }
        };`,
      },
      env: {},
      tails: workerTails(env, ctx, scope === "app" ? app : connector, {
        url: z.url().parse(env["OBSERVER_ORIGIN"]),
        token: "synthetic-log-token",
      }),
    }));

    return worker.getEntrypoint().fetch(request);
  },
} satisfies ExportedHandler<ParentEnvironment>;
