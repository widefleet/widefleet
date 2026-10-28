import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const observation = z.strictObject({
  event: z.strictObject({
    timestamp: z.number(),
    operation: z.enum(["create", "do"]),
    outcome: z.enum(["ok", "unknown", "started"]),
  }),
  identity: z.strictObject({
    appId: z.uuid(),
    version: z.uuid(),
    workflow: z.literal("example"),
    instanceId: z.uuid(),
  }),
});

const source = `import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
export class ExampleWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    if (event.payload.mode === 'fail') return step.do('private-error', async () => { throw new NonRetryableError('private-message'); });
    if (['quick', 'ambiguous'].includes(event.payload.mode)) return step.do('quick', async () => 42);
    await step.do('private-name', async () => 1);
    await step.do('private-name', async () => 2);
    const result = await step.do('retry', { retries: { limit: 2, delay: 1 } }, async ctx => {
      if (ctx.attempt < 3) throw new Error('private-retry');
      return ctx.attempt;
    });
    await step.sleep('nap', 1);
    // The deadline crosses RPC boundaries before the native engine validates it.
    await step.sleepUntil('deadline', Date.now() + 1000);
    await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
    return step.do('finish', async () => ({ result, secret: this.env.OBSERVER_LABEL ?? null }));
  }
}
export default { fetch() { return new Response(); } };`;

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")(
  "Workflow observations in the native local engine",
  () => {
    it("separates creates, first attempts, retries, replays and explicit restarts without gating work", async () => {
      const directory = await mkdtemp(join(tmpdir(), "widefleet-workflow-observer-"));
      const received: z.infer<typeof observation>[] = [];
      const pending: ServerResponse[] = [];
      const errors: Error[] = [];
      let hold = true;

      const collector = createServer((request, response) => {
        const handle = async () => {
          const chunks: Uint8Array[] = [];

          for await (const chunk of request) chunks.push(z.instanceof(Uint8Array).parse(chunk));
          received.push(observation.parse(JSON.parse(Buffer.concat(chunks).toString())));

          if (hold) pending.push(response);
          else response.writeHead(503).end();
        };

        void handle().catch((error: Error) => {
          errors.push(error);
          response.writeHead(500).end();
        });
      });

      let worker: Awaited<ReturnType<typeof import("wrangler").unstable_dev>> | undefined;

      try {
        collector.listen(0, "127.0.0.1");
        await once(collector, "listening");
        const { port } = z.object({ port: z.number() }).parse(collector.address());
        const runtime = import.meta.resolve("@platform/app-runtime/runtime-extension");

        const extension = fileURLToPath(
          new URL("../fixtures/workflow-observer-extension.ts", runtime),
        );

        const compile = async (entry: string) => {
          const result = await build({
            entryPoints: [fileURLToPath(new URL(`${entry}.ts`, runtime))],
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
            external: [
              "cloudflare:*",
              "node:*",
              "./__widefleet_app.js",
              "./__widefleet_workflow.js",
            ],
            alias: {
              "#runtime-extension": extension,
              "widefleet:app": "./__widefleet_app.js",
              "widefleet:workflow": "./__widefleet_workflow.js",
            },
          });

          const text = z.string().parse(result.outputFiles[0]?.text);
          expect(text).not.toContain("workflow-parent-only");

          return text;
        };

        const main = join(directory, "index.js");
        await build({
          entryPoints: [fileURLToPath(new URL("../fixtures/workflow-observer.ts", runtime))],
          outfile: main,
          bundle: true,
          format: "esm",
          platform: "browser",
          external: ["cloudflare:*", "node:*"],
          alias: { "#runtime-extension": extension },
          define: {
            WIDEFLEET_BINDINGS_SOURCE: JSON.stringify(await compile("bindings")),
            WIDEFLEET_EVENTS_SOURCE: JSON.stringify(await compile("events")),
            WIDEFLEET_CLOUDFLARE_WORKFLOW_SOURCE: JSON.stringify(
              await compile("workflow-cloudflare-runner"),
            ),
            WIDEFLEET_WORKFLOW_SOURCE: JSON.stringify(""),
            WIDEFLEET_RUNTIME_VERSION: JSON.stringify("fixture"),
          },
        });

        const app = {
          id: crypto.randomUUID(),
          appId: crypto.randomUUID(),
          version: crypto.randomUUID(),
          deploymentId: crypto.randomUUID(),
          hostname: "workflow.example.test",
          metadata: {
            main_module: "app.js",
            compatibility_date: "2026-10-01",
            compatibility_flags: ["nodejs_compat"],
            assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
            bindings: [
              {
                type: "workflow",
                name: "WORKFLOW",
                workflow_name: "example",
                class_name: "ExampleWorkflow",
              },
            ],
            crons: [],
            queue_consumers: [],
          },
          modules: [
            {
              name: "app.js",
              type: "esm",
              sha256: createHash("sha256").update(source).digest("hex"),
              size: Buffer.byteLength(source),
            },
          ],
          manifest: {},
          nativeBindings: {},
          capabilities: {},
          capabilityRevision: 1,
          network: { revision: 1, policy: { backend: [], browser: [] } },
        };

        const config = join(directory, "wrangler.json");
        await writeFile(
          config,
          JSON.stringify({
            name: "workflow-observer-fixture",
            main,
            compatibility_date: "2026-10-01",
            compatibility_flags: [
              "nodejs_compat",
              "workflows_preserve_non_retryable_error_message",
            ],
            vars: {
              APP: JSON.stringify(app),
              OBSERVER_LABEL: "workflow-parent-only",
              OBSERVER_ORIGIN: `http://127.0.0.1:${port}`,
              WIDEFLEET_HTTP_AVAILABILITY: "kv",
            },
            worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
            r2_buckets: [{ binding: "WIDEFLEET_PACKAGES", bucket_name: "fixture" }],
            kv_namespaces: [{ binding: "AUTH_CONFIG", id: "fixture" }],
            durable_objects: {
              bindings: [{ name: "WIDEFLEET_WORKFLOW_CATALOG", class_name: "Catalog" }],
            },
            migrations: [{ tag: "v1", new_sqlite_classes: ["Catalog"] }],
            workflows: [
              {
                binding: "WIDEFLEET_WORKFLOWS",
                name: "fixture",
                class_name: "CloudflareAppWorkflow",
              },
            ],
          }),
        );
        const { unstable_dev } = await import("wrangler");
        worker = await unstable_dev(main, {
          config,
          local: true,
          persist: false,
          ip: "127.0.0.1",
          port: 0,
          inspectorPort: 0,
          logLevel: "error",
          experimental: {
            disableExperimentalWarning: true,
            disableDevRegistry: true,
            watch: false,
          },
        });
        const active = worker;
        expect(
          (await active.fetch("http://fixture/publish", { method: "POST", body: source })).status,
        ).toBe(204);

        const call = async (
          body: Record<string, z.infer<ReturnType<typeof z.json>>>,
          requestId = crypto.randomUUID(),
        ) => {
          const response = await active.fetch("http://fixture/", {
            method: "POST",
            headers: { "x-request-id": requestId },
            body: JSON.stringify({ workflow: "example", ...body }),
          });

          return z.json().parse(await response.json());
        };

        const count = (operation: string) =>
          received.filter((item) => item.event.operation === operation).length;

        const complete = async (id: string, output: z.infer<ReturnType<typeof z.json>>) => {
          await expect
            .poll(() => call({ action: "status", id }), { timeout: 15000 })
            .toMatchObject({ result: { status: "complete", output } });
        };

        const id = "application-selected-id";
        const requestId = crypto.randomUUID();

        const create = {
          action: "create",
          id,
          params: {
            mode: "wait",
            appId: "spoofed",
            instanceId: "spoofed",
            secret: "private-param",
          },
        };

        expect(await call(create, requestId)).toEqual({ result: { id } });
        await expect.poll(() => count("do"), { timeout: 15000 }).toBe(3);
        expect(count("create")).toBe(1);
        // Delivery remains pending while all first attempts and retries execute.
        expect(pending).toHaveLength(4);
        expect(await call(create, requestId)).toEqual({ result: { id } });
        expect(await call(create)).toMatchObject({ error: "Workflow instance already exists" });
        await active.fetch("http://fixture/availability", {
          method: "POST",
          body: '{"blocked":true}',
        });
        const blocked = { error: "Organization execution is suspended" };
        expect(await call({ action: "create", id: "blocked", params: { mode: "quick" } })).toEqual(
          blocked,
        );
        expect(await call({ action: "restart", id })).toEqual(blocked);
        expect(await call({ action: "resume", id })).toEqual(blocked);
        await call({ action: "pause", id });
        await active.fetch("http://fixture/availability", {
          method: "POST",
          body: '{"blocked":false}',
        });
        await call({ action: "resume", id });
        await call({ action: "sendEvent", id, event: { type: "continue", payload: {} } });
        await complete(id, { result: 3, secret: null });
        await expect.poll(() => count("do")).toBe(4);
        expect(count("create")).toBe(1);
        expect(new Set(received.map((item) => item.identity.instanceId)).size).toBe(1);

        for (const item of received) {
          expect(item.identity).toEqual({
            appId: app.appId,
            version: app.version,
            workflow: "example",
            instanceId: item.identity.instanceId,
          });
          expect(item.identity.instanceId).not.toBe(id);
        }

        // Partial restart reuses the first two results, reexecutes retry and finish.
        await call({ action: "restart", id, from: { name: "retry", type: "do", count: 1 } });
        await expect.poll(() => count("do")).toBe(5);
        await call({ action: "sendEvent", id, event: { type: "continue", payload: {} } });
        await complete(id, { result: 3, secret: null });
        await expect.poll(() => count("do")).toBe(6);
        expect(count("create")).toBe(1);
        // A failed observer never becomes a workflow retry or changes its result.
        hold = false;

        for (const response of pending) response.writeHead(503).end();
        await call({ action: "restart", id });
        await expect.poll(() => count("do")).toBe(9);
        await call({ action: "sendEvent", id, event: { type: "continue", payload: {} } });
        await complete(id, { result: 3, secret: null });
        await expect.poll(() => count("do")).toBe(10);
        expect(count("create")).toBe(1);
        expect(
          await call({ action: "create", id: "ambiguous", params: { mode: "ambiguous" } }),
        ).toEqual({ result: { id: "ambiguous" } });
        await complete("ambiguous", 42);
        expect(
          await call({ action: "create", id: "missing", params: { mode: "missing" } }),
        ).toEqual({ error: "Synthetic create response lost" });
        // A thrown blockConcurrencyWhile callback resets the catalog and can
        // cancel its background send. The ambiguous-but-recovered create is
        // observable; a fully rejected creation has no delivery guarantee.
        const creationEvents = received.filter((item) => item.event.operation === "create");
        expect(creationEvents.length).toBeGreaterThanOrEqual(2);
        expect(creationEvents.length).toBeLessThanOrEqual(3);
        expect(
          received.flatMap((item) =>
            item.event.operation === "create" ? [item.event.outcome] : [],
          ),
        ).toEqual(["ok", ...Array.from({ length: creationEvents.length - 1 }, () => "unknown")]);

        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await call({ action: "status", id: "missing" })).toMatchObject({
            result: { status: "unknown" },
          });
          await call({ action: "list" });
        }

        expect(count("create")).toBe(creationEvents.length);
        expect(await call({ action: "create", id: "failed", params: { mode: "fail" } })).toEqual({
          result: { id: "failed" },
        });
        await expect
          .poll(() => call({ action: "status", id: "failed" }))
          .toMatchObject({ result: { status: "errored", error: { message: "private-message" } } });
        await expect.poll(() => count("do")).toBe(12);

        const batch = await active.fetch("http://fixture/batch", {
          method: "POST",
          body: JSON.stringify(["a", "b", "a"]),
        });

        expect(await batch.json()).toEqual([{ id: "a" }, { id: "b" }]);
        await complete("a", 42);
        await complete("b", 42);
        await expect.poll(() => count("create")).toBe(creationEvents.length + 3);
        await expect.poll(() => count("do")).toBe(14);
        const serialized = JSON.stringify(received);

        for (const forbidden of [
          "private-param",
          "private-name",
          "private-message",
          "private-retry",
          "spoofed",
        ])
          expect(serialized).not.toContain(forbidden);
        expect(errors).toEqual([]);
      } finally {
        for (const response of pending) if (!response.writableEnded) response.end();
        await worker?.stop();
        collector.closeAllConnections();
        await new Promise<void>((resolve) => collector.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
