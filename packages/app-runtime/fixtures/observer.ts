import { z } from "zod";
import { workerTails } from "../src/worker-definition.ts";
import type { ParentEnvironment } from "../src/types.ts";

export { RuntimeObserver } from "../src/runtime-observer.ts";

export { KeyValue } from "../src/storage.ts";

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
    const path = new URL(request.url).pathname;
    const scope = path.startsWith("/connector") ? "connector" : "app";
    const keyValue = path.endsWith("/kv");

    const worker = env.WIDEFLEET_LOADER.get(`${scope}:${keyValue}`, () => ({
      mainModule: "child.js",
      compatibilityDate: "2026-10-01",
      modules: {
        "child.js": keyValue
          ? `export default {
          async fetch(request, env) {
            const kv = env.STORE;
            const call = (input, body) => kv.fetch(new Request("https://kv.invalid", {
              method: body === undefined ? "GET" : "PUT",
              headers: { "x-widefleet-kv": encodeURIComponent(JSON.stringify(input)) },
              body
            }));
            const written = await call({ method: "put", key: "secret-key", options: {
              metadata: { private: "secret-metadata" }
            } }, "secret-value");
            const found = await call({ method: "get", key: "secret-key" });
            const value = await found.text();
            const missing = await call({ method: "get", key: "absent-key" });
            await missing.text();
            const many = await kv.getMany(["secret-key", "absent-key", "secret-key"]);
            const listed = await kv.list({ limit: 1 });
            await kv.delete("secret-key");
            await kv.delete("absent-key");
            const empty = await kv.list();
            const failedWrite = await call({ method: "put", key: "", options: {} }, "value");
            const failedRead = await call({ method: "get", key: "" });
            let failedBulk = false;
            let failedDelete = false;
            try { await kv.getMany([""]); } catch { failedBulk = true; }
            try { await kv.delete(""); } catch { failedDelete = true; }
            return Response.json({
              written: written.status, value, missing: missing.status,
              many: many.map(([key, result]) => [key, result?.value ?? null]),
              listed: listed.keys.length, empty: empty.keys.length,
              failedWrite: failedWrite.status, failedRead: failedRead.status,
              failedBulk, failedDelete, bindings: Object.keys(env)
            });
          }
        };`
          : `export default {
          fetch(request, env) {
            console.log('observer fixture log');
            return Response.json(Object.keys(env));
          }
        };`,
      },
      env: keyValue
        ? {
            STORE: ctx.exports.KeyValue({
              props: {
                name: "OBSERVER_KV",
                binding: "APP_KV",
                identity: scope === "app" ? app : connector,
              },
            }),
          }
        : {},
      tails: keyValue
        ? []
        : workerTails(env, ctx, scope === "app" ? app : connector, {
            url: z.url().parse(env["OBSERVER_ORIGIN"]),
            token: "synthetic-log-token",
          }),
    }));

    return worker.getEntrypoint().fetch(request);
  },
} satisfies ExportedHandler<ParentEnvironment>;
