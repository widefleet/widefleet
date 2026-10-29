import { z } from "zod";
import { publishedApp } from "@platform/contracts";
import { workerTails } from "../src/worker-definition.ts";
import { workerCode } from "../src/worker.ts";
import { digest } from "./digest.ts";
import type { ParentEnvironment } from "../src/types.ts";

export { RuntimeObserver } from "../src/runtime-observer.ts";

export { KeyValue } from "../src/storage.ts";

export { Telemetry } from "../src/telemetry.ts";

export { CloudflareTelemetry } from "../src/telemetry-cloudflare.ts";

export { AppSecrets } from "../src/app-secrets.ts";

export { Assets } from "../src/assets.ts";

export { Gateway } from "../src/egress.ts";

const app = {
  appId: "a0000000-0000-4000-8000-000000000001",
  deploymentId: "a0000000-0000-4000-8000-000000000002",
  buildId: null,
};

const service = {
  organizationId: "observer-fixture",
  appId: "a0000000-0000-4000-8000-000000000004",
  buildId: null,
  deploymentId: "a0000000-0000-4000-8000-000000000003",
};

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const scope = path.startsWith("/service") ? "service" : "app";
    const identity = scope === "app" ? app : service;
    const keyValue = path.endsWith("/kv");

    if (path.endsWith("/production-kv")) {
      const source = `export default {
        async fetch(request, env) {
          return Response.json({
            value: await env.APP_KV.get('missing'),
            observerBindingVisible: 'OBSERVER_LABEL' in env
          });
        }
      };`;

      const sha256 = await digest(source);
      const prefix = `apps/${identity.appId}`;
      await env.WIDEFLEET_PACKAGES.put(`${prefix}/modules/${sha256}`, source);
      const modules = [{ name: "child.js", type: "esm", sha256, size: source.length }];

      const metadata = {
        main_module: "child.js",
        compatibility_date: "2026-10-01",
        bindings: [{ type: "kv_namespace", name: "APP_KV", id: "fixture" }],
      };

      const nativeBindings = { APP_KV: "OBSERVER_KV" };

      const worker = env.WIDEFLEET_LOADER.get(`${scope}:production`, () =>
        workerCode(
          publishedApp.parse({
            id: identity.appId,
            appId: identity.appId,
            deploymentId: identity.deploymentId,
            version: identity.deploymentId,
            hostname: "observer.example.test",
            organizationId: scope === "app" ? undefined : "observer-fixture",
            metadata: {
              ...metadata,
              web: scope === "app",
              entrypoints: scope === "app" ? [] : ["default"],
              assets: { binding: "ASSETS", upload_session: identity.deploymentId },
            },
            manifest: {},
            modules,
            nativeBindings,
            network: { revision: 1, policy: { backend: [], browser: [] } },
          }),
          env,
          ctx,
        ),
      );

      return worker.getEntrypoint().fetch(request);
    }

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
                identity: scope === "app" ? app : service,
              },
            }),
          }
        : {},
      tails: keyValue
        ? []
        : workerTails(env, ctx, scope === "app" ? app : service, {
            url: z.url().parse(env["OBSERVER_ORIGIN"]),
            token: "synthetic-log-token",
          }),
    }));

    return worker.getEntrypoint().fetch(request);
  },
} satisfies ExportedHandler<ParentEnvironment>;
