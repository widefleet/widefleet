import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { applicationSource } from "./workflow-adapter.fixture.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const observation = z.object({ id: z.string(), label: z.string() });

describe.runIf(process.env["RUN_DYNAMIC_TESTS"] === "1")(
  "Standard Workflow API through a platform adapter on unchanged celld",
  () => {
    let directory: string;
    let appId: string;
    let processHandle: ReturnType<typeof spawn>;
    let observer: ReturnType<typeof createServer>;
    const delayedOrigin = "https://async.fixture";
    let observeOrigin: string;
    let origin: string;
    let runtimeLogs = "";
    let deniedRequests = 0;
    const records: z.infer<typeof observation>[] = [];

    const fetchCounts = new Map<string, number>();

    const listen = async (server: ReturnType<typeof createServer>) => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");

      return z.object({ port: z.number() }).parse(server.address()).port;
    };

    const stop = async (crash = false) => {
      if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
        const exited = once(processHandle, "exit");
        processHandle.kill(crash ? "SIGKILL" : "SIGTERM");
        const timeout = setTimeout(() => processHandle.kill("SIGKILL"), 15000);
        await exited;
        clearTimeout(timeout);
      }
    };

    const start = async () => {
      const reservation = createServer();
      const port = await listen(reservation);
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      origin = `http://127.0.0.1:${port}`;
      processHandle = spawn(
        join(root, ".tools/celld"),
        ["dev", directory, "--port", String(port), "--no-watch", "--logs"],
        {
          env: { ...process.env, CELLD_SHUTDOWN_TOTAL_MS: "2000" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      processHandle.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        runtimeLogs += chunk;
      });
      processHandle.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        runtimeLogs += chunk;
      });
      await vi.waitFor(
        async () => {
          if (processHandle.exitCode !== null) throw new Error(runtimeLogs);
          expect((await fetch(`${origin}/.well-known/celld/health`)).ok).toBe(true);
        },
        { timeout: 20000 },
      );
    };

    // Every operation goes through a Dynamic Worker's ordinary env.WORKFLOW
    // methods. The test does not call the native Workflow binding directly.
    const call = async (operation: string, id: string, fields: Record<string, string> = {}) => {
      const response = await fetch(
        `${origin}/${operation}?${new URLSearchParams({ id, ...fields })}`,
      );

      const text = await response.text();

      if (!response.ok) throw new Error(text);

      return z.json().parse(JSON.parse(text));
    };

    const create = async (mode: string, fields: Record<string, string> = {}) => {
      const id = crypto.randomUUID();
      expect(await call("create", id, { mode, ...fields })).toEqual({ id });

      return id;
    };

    const status = async (id: string, expected: string) => {
      await vi.waitFor(
        async () => {
          const actual = await call("status", id);
          expect(actual, JSON.stringify(actual)).toMatchObject({ status: expected });
        },
        { timeout: 5000, interval: 20 },
      );

      return call("status", id);
    };

    const labels = (id: string) =>
      records.flatMap((record) => (record.id === id ? [record.label] : []));

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-workflow-adapter-test-"));
      observer = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://observer.fixture");

        if (url.pathname === "/record") {
          const entry = observation.parse(Object.fromEntries(url.searchParams));
          records.push(entry);
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              ok: true,
              count: labels(entry.id).filter((label) => label === entry.label).length,
            }),
          );

          return;
        } else if (url.pathname === "/reorder") {
          const key = `${url.searchParams.get("id")}/${url.searchParams.get("branch")}`;
          const count = (fetchCounts.get(key) ?? 0) + 1;
          fetchCounts.set(key, count);
          const delay = (url.searchParams.get("branch") === "left") === (count === 1) ? 20 : 200;
          response.setHeader("content-type", "application/json");
          const complete = () => response.end(JSON.stringify({ delay }));

          if (url.searchParams.get("mode") === "reordered-fetch") setTimeout(complete, delay);
          else complete();

          return;
        } else {
          deniedRequests++;
        }

        response.setHeader("content-type", "application/json");
        response.end('{"ok":true}');
      });
      observeOrigin = `http://127.0.0.1:${await listen(observer)}`;
      appId = crypto.randomUUID();
      const version = crypto.randomUUID();
      const hash = createHash("sha256").update(applicationSource).digest("hex");

      const app = {
        id: crypto.randomUUID(),
        appId,
        version,
        deploymentId: crypto.randomUUID(),
        hostname: "127.0.0.1",
        metadata: {
          main_module: "app.js",
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          bindings: [
            {
              type: "workflow",
              name: "WORKFLOW",
              workflow_name: "fixture",
              class_name: "AppWorkflow",
            },
            { type: "d1", name: "DB", database_name: "workflow-test" },
            { type: "r2_bucket", name: "FILES", bucket_name: "workflow-test" },
            { type: "kv_namespace", name: "KV", id: "workflow-test" },
          ],
          assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
          crons: [],
          queue_consumers: [],
        },
        modules: [
          { name: "app.js", type: "esm", sha256: hash, size: Buffer.byteLength(applicationSource) },
        ],
        manifest: {},
        nativeBindings: { DB: "DB", FILES: "FILES", KV: "KV" },
        capabilities: { OBSERVE: "OBSERVE" },
        capabilityRevision: 1,
        network: { revision: 1, policy: { backend: [delayedOrigin], browser: [] } },
      };

      await writeFile(
        join(directory, "runtime.js"),
        await readFile(join(root, "packages/app-runtime/dist/loader.js")),
      );
      await writeFile(
        join(directory, "index.js"),
        `
        import runtime, { Gateway as RuntimeGateway } from './runtime.js';
        import { WorkerEntrypoint } from 'cloudflare:workers';
        export * from './runtime.js';
        export class Gateway extends RuntimeGateway {
          async fetch(request) {
            if (new URL(request.url).origin !== ${JSON.stringify(delayedOrigin)}) return super.fetch(request);
            if (new URL(request.url).pathname === '/reorder') return fetch(${JSON.stringify(observeOrigin)} + '/reorder' + new URL(request.url).search);
            await new Promise(resolve => setTimeout(resolve, 100));
            return new Response(new ReadableStream({ start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ready":'));
              setTimeout(() => { controller.enqueue(new TextEncoder().encode('true}')); controller.close(); }, 100);
            } }), { headers: { 'content-type': 'application/json' } });
          }
        }
        export class Observe extends WorkerEntrypoint {
          async record(id, label) { return (await fetch(${JSON.stringify(observeOrigin)} + '/record?' + new URLSearchParams({ id, label }))).json(); }
        }
        export default { async fetch(request, env, ctx) {
          const path = new URL(request.url).pathname;
          if (path === '/fixture/init') {
            const app = ${JSON.stringify(app)};
            await env.WIDEFLEET_PACKAGES.put('apps/${appId}/modules/${hash}', ${JSON.stringify(applicationSource)});
            await env.WIDEFLEET_PACKAGES.put('versions/${appId}/${version}.json', JSON.stringify(app));
            await env.WIDEFLEET_PACKAGES.put('hosts/127.0.0.1.json', JSON.stringify(app));
            return Response.json({ ok: true });
          }
          if (path === '/fixture/deploy') {
            const previous = await (await env.WIDEFLEET_PACKAGES.get('hosts/127.0.0.1.json')).json();
            const next = { ...previous, version: crypto.randomUUID(), capabilities: {}, capabilityRevision: 2 };
            const source = ${JSON.stringify(applicationSource)}.replace('(a + next.payload.add) * 2', '(a + next.payload.add) * 3');
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))), byte => byte.toString(16).padStart(2, '0')).join('');
            next.modules = [{ ...next.modules[0], sha256: hash, size: new TextEncoder().encode(source).length }];
            if (new URL(request.url).searchParams.has('keepConnector')) next.capabilities = previous.capabilities;
            await env.WIDEFLEET_PACKAGES.put('apps/${appId}/modules/' + hash, source);
            await env.WIDEFLEET_PACKAGES.put('versions/${appId}/' + next.version + '.json', JSON.stringify(next));
            await env.WIDEFLEET_PACKAGES.put('hosts/127.0.0.1.json', JSON.stringify(next));
            return Response.json({ version: next.version });
          }
          return runtime.fetch(request, env, ctx);
        } };
      `,
      );
      await build({
        entryPoints: [join(directory, "index.js")],
        outfile: join(directory, "bundle.js"),
        bundle: true,
        format: "esm",
        platform: "neutral",
        external: ["cloudflare:*", "node:*"],
        logLevel: "silent",
      });
      await writeFile(
        join(directory, "wrangler.json"),
        JSON.stringify({
          name: "adapter-probe",
          main: "bundle.js",
          no_bundle: true,
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          vars: {
            PLATFORM_SECRET: "synthetic-host-only",
            WIDEFLEET_CONTROL_TOKEN: "synthetic-control",
            WIDEFLEET_CONFIGURATION: '{"crons":{},"queues":{}}',
          },
          worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
          r2_buckets: [
            { binding: "WIDEFLEET_PACKAGES", bucket_name: "widefleet-packages" },
            { binding: "FILES", bucket_name: "workflow-test" },
          ],
          d1_databases: [
            { binding: "DB", database_name: "workflow-test", database_id: "workflow-test" },
          ],
          kv_namespaces: [{ binding: "KV", id: "workflow-test" }],
          durable_objects: {
            bindings: [
              { name: "WIDEFLEET_WORKFLOW_CATALOG", class_name: "WidefleetWorkflowCatalog" },
            ],
          },
          services: [
            {
              binding: "WIDEFLEET_WORKFLOW_SESSIONS",
              service: "adapter-probe",
              entrypoint: "WorkflowSessions",
            },
            { binding: "OBSERVE", service: "adapter-probe", entrypoint: "Observe" },
          ],
          workflows: [
            { binding: "WIDEFLEET_WORKFLOWS", name: "widefleet-apps", class_name: "AppWorkflow" },
          ],
        }),
      );
      await start();
      expect((await fetch(`${origin}/fixture/init`)).ok).toBe(true);
    }, 30000);

    afterAll(async () => {
      await stop();

      if (observer) await new Promise<void>((resolve) => observer.close(() => resolve()));

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    const manage = async (
      request: z.infer<ReturnType<typeof z.json>>,
      requestId = crypto.randomUUID(),
    ) => {
      const response = await fetch(`${origin}/.well-known/widefleet/workflows`, {
        method: "POST",
        headers: { authorization: "Bearer synthetic-control", "content-type": "application/json" },
        body: JSON.stringify({ appId, hostname: "127.0.0.1", requestId, request }),
      });

      const result = z.json().parse(await response.json());

      if (!response.ok) throw new Error(JSON.stringify(result));

      return result;
    };

    it("retains committed steps and receives events after an abrupt process restart", async () => {
      const id = await create("sequential");
      await status(id, "waiting");
      expect(labels(id)).toEqual(["first"]);
      await stop(true);
      await start();
      expect(await call("status", id)).toMatchObject({ status: "waiting" });
      await call("continue", id);
      expect(await status(id, "complete")).toMatchObject({ output: 42 });
      expect(labels(id)).toEqual(["first", "finish"]);
    }, 30000);

    it("supports sleep and sleepUntil without repeating completed callbacks", async () => {
      const started = Date.now();
      const id = await create("sleep");
      expect(await status(id, "complete")).toMatchObject({ output: 40 });
      expect(labels(id)).toEqual(["first", "finish"]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    });

    it("uses native retries and passes their attempt numbers into app callbacks", async () => {
      const id = await create("retry");
      expect(await status(id, "complete")).toMatchObject({ output: 3 });
      expect(labels(id)).toEqual(["attempt-1", "attempt-2", "attempt-3"]);
    });

    it("preserves catch and NonRetryableError through replay", async () => {
      const id = await create("catch");
      await status(id, "waiting");
      await stop();
      await start();
      await call("continue", id);
      expect(await status(id, "complete")).toMatchObject({
        output: { name: "NonRetryableError", message: "permanent fixture" },
      });
      expect(labels(id)).toEqual(["failure"]);
    }, 30000);

    it("runs parallel callbacks with repeated step names", async () => {
      const id = await create("parallel");
      expect(await status(id, "complete")).toMatchObject({ output: 6 });
      expect(labels(id).sort()).toEqual(["value-1", "value-2", "value-3"]);
    });

    it("finishes an independent branch before the parallel event arrives, including replay", async () => {
      const id = await create("mixed");
      await status(id, "waiting");
      expect(labels(id)).toEqual(["first", "second"]);
      await stop(true);
      await start();
      await call("continue", id);
      expect(await status(id, "complete")).toMatchObject({
        output: [{ payload: { add: 1 }, type: "continue" }, 21],
      });
      expect(labels(id)).toEqual(["first", "second"]);
    }, 30000);

    it("supports control flow with repeated step names in a loop", async () => {
      const id = await create("loop");
      expect(await status(id, "complete")).toMatchObject({ output: 3 });
      expect(labels(id)).toEqual(["loop-0", "loop-1", "loop-2"]);
    });

    it("keeps asynchronous setup before the first step alive and releases canceled timers", async () => {
      const id = await create("before-first", { url: delayedOrigin });
      await status(id, "waiting");
      await call("continue", id);
      expect(await status(id, "complete")).toMatchObject({ output: 23 });
      expect(labels(id)).toEqual(["first"]);
    });

    it.each(["delayed-timer", "delayed-fetch"])(
      "delivers commands after %s while a native event is pending and preserves replay",
      async (mode) => {
        const id = await create(mode, { url: delayedOrigin });
        await vi.waitFor(
          async () =>
            expect(labels(id), JSON.stringify(await call("status", id))).toEqual([
              "first",
              "signal",
            ]),
          { timeout: 5000 },
        );
        await status(id, "waiting");
        await stop(true);
        await start();
        await call("continue", id);
        expect(await status(id, "complete")).toMatchObject({
          output: [{ payload: { ready: true }, type: "signal" }, 21, 22],
        });
        expect(labels(id)).toEqual(["first", "signal"]);
      },
      30000,
    );

    it("preserves callback step names and occurrence counts without checkpoint collisions", async () => {
      const id = await create("context");
      expect(await status(id, "complete")).toMatchObject({
        output: [
          { name: "__bridge_turn_0", count: 1 },
          { name: "__bridge_turn_0", count: 2 },
          { name: "", count: 1 },
        ],
      });
    });

    it.each(["reordered-fetch", "reordered-timer"])(
      "matches replayed results to their steps when %s reverses parallel branches",
      async (mode) => {
        const id = await create(mode, { url: `${delayedOrigin}/reorder` });
        await status(id, "waiting");
        expect(labels(id)).toEqual(["left", "left-next", "right", "right-next"]);
        await stop(true);
        await start();
        await call("continue", id);
        expect(await status(id, "complete")).toMatchObject({ output: [11, 21] });
        expect(labels(id)).toEqual(["left", "left-next", "right", "right-next", "finish"]);
        expect(fetchCounts.get(`${id}/left`)).toBeGreaterThanOrEqual(2);
        expect(fetchCounts.get(`${id}/right`)).toBeGreaterThanOrEqual(2);
      },
      30000,
    );

    it("preserves structured-clone step results when reconstructing the app after a restart", async () => {
      const id = await create("values");
      await status(id, "waiting");
      await stop(true);
      await start();
      await call("continue", id);
      expect(await status(id, "complete")).toMatchObject({
        output: { date: "2026-01-01T00:00:00.000Z", bytes: [3, 5], map: 7 },
      });
      expect(labels(id)).toEqual(["values"]);
    }, 30000);

    it("keeps concurrent Workflow instance callbacks and results separate", async () => {
      const ids = await Promise.all([create("sequential"), create("sequential")]);
      await Promise.all(ids.map((id) => status(id, "waiting")));
      await Promise.all(ids.map((id) => call("continue", id)));

      for (const id of ids) {
        expect(await status(id, "complete")).toMatchObject({ output: 42 });
        expect(labels(id)).toEqual(["first", "finish"]);
      }
    });

    it("supports pause, buffered events, resume, restart and termination through the app binding", async () => {
      const id = await create("sequential");
      await status(id, "waiting");
      await call("pause", id);
      await status(id, "paused");
      await call("continue", id);
      expect(await call("status", id)).toMatchObject({ status: "paused" });
      expect(labels(id)).toEqual(["first"]);
      await call("resume", id);
      expect(await status(id, "complete")).toMatchObject({ output: 42 });
      await call("restart", id);
      await status(id, "waiting");
      expect(labels(id)).toEqual(["first", "finish", "first"]);
      await call("terminate", id);
      await status(id, "terminated");
      expect(labels(id)).toEqual(["first", "finish", "first"]);
    });

    it("restarts a completed step while retaining earlier results and consumed events", async () => {
      const id = await create("sequential");
      await status(id, "waiting");
      await call("continue", id);
      await status(id, "complete");
      await call("restart", id, { options: JSON.stringify({ from: { name: "finish" } }) });
      expect(await status(id, "complete")).toMatchObject({ output: 42 });
      expect(labels(id)).toEqual(["first", "finish", "finish"]);
    });

    it("selects a repeated step occurrence after an abrupt runtime restart", async () => {
      const id = await create("loop");
      await status(id, "complete");
      await stop(true);
      await start();
      await call("restart", id, {
        options: JSON.stringify({ from: { name: "same-name", count: 2 } }),
      });
      expect(await status(id, "complete")).toMatchObject({ output: 3 });
      expect(labels(id)).toEqual(["loop-0", "loop-1", "loop-2", "loop-1", "loop-2"]);
    }, 30000);

    it("recovers an errored step without repeating earlier callbacks", async () => {
      const id = await create("restart-error");
      await status(id, "errored");
      await call("restart", id, { options: JSON.stringify({ from: { name: "recover" } }) });
      expect(await status(id, "complete")).toMatchObject({ output: 2 });
      expect(labels(id)).toEqual(["first", "recover", "recover"]);
    });

    it("recomputes branches and checkpoints after a selective restart with active asynchronous work", async () => {
      const id = await create("restart-branch");
      expect(await status(id, "complete")).toMatchObject({ output: [1, 99] });
      await call("restart", id, { options: JSON.stringify({ from: { name: "choose" } }) });
      expect(await status(id, "complete")).toMatchObject({ output: [2, 99] });
      expect(labels(id)).toEqual(["first", "choose", "old", "other", "choose", "new", "other"]);
    });

    it("retains only earlier parallel steps when restarting a repeated name", async () => {
      const id = await create("parallel");
      await status(id, "complete");
      await call("restart", id, {
        options: JSON.stringify({ from: { name: "same-name", count: 2 } }),
      });
      expect(await status(id, "complete")).toMatchObject({ output: 6 });
      expect(labels(id).sort()).toEqual(["value-1", "value-2", "value-2", "value-3", "value-3"]);
    });

    it.each(["do", "sleep", "waitForEvent"])(
      "disambiguates %s steps sharing a name and waits for fresh events",
      async (type) => {
        const id = await create("restart-types");
        await status(id, "waiting");
        await call("continue", id);
        expect(await status(id, "complete")).toMatchObject({
          output: { name: "shared", count: 3 },
        });
        await call("restart", id, {
          options: JSON.stringify({ from: { name: "shared", type, count: type === "do" ? 2 : 1 } }),
        });
        await status(id, "waiting");
        await vi.waitFor(() =>
          expect(labels(id)).toEqual(
            type === "waitForEvent" ? ["do-1", "do-2", "do-3"] : ["do-1", "do-2", "do-3", "do-2"],
          ),
        );
        await call("continue", id);
        expect(await status(id, "complete")).toMatchObject({
          output: { name: "shared", count: 3 },
        });
      },
    );

    it("selects sleepUntil as a sleep occurrence while the instance is paused", async () => {
      const id = await create("restart-until");
      await vi.waitFor(() => expect(labels(id)).toEqual(["before-until"]));
      await status(id, "waiting");
      await call("pause", id);
      await status(id, "paused");
      await call("restart", id, {
        options: JSON.stringify({ from: { name: "nap", count: 2, type: "sleep" } }),
      });
      await status(id, "waiting");
      expect(labels(id)).toEqual(["before-until"]);
      await call("terminate", id);
      await status(id, "terminated");
    });

    it("restarts a pending event wait without retaining buffered events", async () => {
      const id = await create("sequential");
      await status(id, "waiting");
      await call("pause", id);
      await status(id, "paused");
      await call("continue", id);
      await call("restart", id, {
        options: JSON.stringify({ from: { name: "continue", type: "waitForEvent" } }),
      });
      await status(id, "waiting");
      expect(labels(id)).toEqual(["first"]);
      await call("continue", id);
      expect(await status(id, "complete")).toMatchObject({ output: 42 });
      expect(labels(id)).toEqual(["first", "finish"]);
    });

    it.each(["", "bridge/0", "é/".repeat(128)])(
      "keeps logical step names distinct from internal checkpoints: %s",
      async (name) => {
        const id = await create("restart-name", { name });
        await status(id, "complete");
        await call("restart", id, { options: JSON.stringify({ from: { name } }) });
        expect(await status(id, "complete")).toMatchObject({ output: { count: 2 } });
        expect(labels(id)).toEqual(["first", "named", "named"]);
      },
    );

    it("rejects invalid and absent targets without changing the instance", async () => {
      const id = await create("loop");
      await status(id, "complete");

      for (const from of [
        { name: "missing" },
        { name: "bridge/0" },
        { name: "same-name", count: 4 },
        { name: "same-name", type: "sleep" },
        { name: "same-name", count: 0 },
        { name: "same-name", type: "unknown" },
        { name: "same-name", extra: true },
      ]) {
        await expect(call("restart", id, { options: JSON.stringify({ from }) })).rejects.toThrow();
        expect(await call("status", id)).toMatchObject({ status: "complete", output: 3 });
        expect(labels(id)).toEqual(["loop-0", "loop-1", "loop-2"]);
      }

      await expect(
        call("restart", id, { options: JSON.stringify({ from: { name: "same-name", count: 4 } }) }),
      ).rejects.toThrow('Workflow history has no do step "same-name" occurrence 4');
      await expect(call("restart", id, { options: "null" })).rejects.toThrow();
    });

    it("deduplicates selective management restarts and includes the target in request identity", async () => {
      const id = await create("loop");
      await status(id, "complete");
      const requestId = crypto.randomUUID();

      const request = {
        action: "restart",
        workflow: "fixture",
        id,
        from: { name: "same-name", count: 3 },
      };

      expect(await manage(request, requestId)).toEqual({ result: null });
      await status(id, "complete");
      await stop(true);
      await start();
      expect(await manage(request, requestId)).toEqual({ result: null });
      expect(labels(id)).toEqual(["loop-0", "loop-1", "loop-2", "loop-2"]);
      await expect(
        manage({ ...request, from: { name: "same-name", count: 2 } }, requestId),
      ).rejects.toThrow("already used");
    }, 30000);

    it("keeps ungranted networking and parent secrets inaccessible to app steps", async () => {
      const id = await create("denied", { url: `${observeOrigin}/denied` });

      const result = z
        .object({ output: z.object({ status: z.number(), secret: z.null() }) })
        .parse(await status(id, "complete"));

      expect(result.output.status).toBe(403);
      expect(deniedRequests).toBe(0);
    });

    it("enforces the native step timeout on a callback running inside the Dynamic Worker", async () => {
      const id = await create("timeout");

      const result = z
        .object({ error: z.object({ name: z.string(), message: z.string() }) })
        .parse(await status(id, "errored"));

      expect(result.error.message).toContain("timed out after 20 ms");
    });
    it("uses scoped native storage from Workflow callbacks across a crash", async () => {
      const id = await create("resources");
      await status(id, "waiting");
      await stop(true);
      await start();
      await call("continue", id);
      expect(await status(id, "complete")).toMatchObject({
        output: { row: id, kv: "saved", file: "saved" },
      });
    });

    it("pins code versions while new instances use the newly published code", async () => {
      const old = await create("sequential");
      await status(old, "waiting");
      expect((await fetch(`${origin}/fixture/deploy?keepConnector=1`)).ok).toBe(true);
      const next = await create("sequential");
      await status(next, "waiting");
      await stop(true);
      await start();
      await call("continue", old);
      await call("continue", next);
      expect(await status(old, "complete")).toMatchObject({ output: 42 });
      expect(await status(next, "complete")).toMatchObject({ output: 63 });
      expect((await fetch(`${origin}/fixture/init`)).ok).toBe(true);
    });

    it("applies connector revocation when a pinned Workflow resumes", async () => {
      const id = await create("permissions");
      await status(id, "waiting");
      expect((await fetch(`${origin}/fixture/deploy`)).ok).toBe(true);
      await stop(true);
      await start();
      await call("continue", id);
      expect(await status(id, "complete")).toMatchObject({
        output: { connector: false, secret: null },
      });
      expect((await fetch(`${origin}/fixture/init`)).ok).toBe(true);
    });

    it("lists durable instances and deduplicates management requests across restarts", async () => {
      const requestId = crypto.randomUUID();
      const id = crypto.randomUUID();

      const input = {
        action: "create",
        workflow: "fixture",
        id,
        params: { id, mode: "sequential" },
      };

      expect(await manage(input, requestId)).toEqual({ result: { id } });
      await status(id, "waiting");
      await stop(true);
      await start();
      expect(await manage(input, requestId)).toEqual({ result: { id } });

      const listed = z
        .object({ result: z.object({ instances: z.array(z.object({ id: z.string() })) }) })
        .parse(await manage({ action: "list", workflow: "fixture" }));

      expect(listed.result.instances.some((instance) => instance.id === id)).toBe(true);
      await manage({
        action: "sendEvent",
        workflow: "fixture",
        id,
        event: { type: "continue", payload: { add: 1 } },
      });
      expect(await status(id, "complete")).toMatchObject({ output: 42 });
      await expect(manage({ ...input, id: crypto.randomUUID() }, requestId)).rejects.toThrow(
        "already used",
      );
      const response = await fetch(`${origin}/.well-known/widefleet/workflows`, { method: "POST" });
      expect(response.status).toBe(403);
    });

    it("preserves custom NonRetryableError names and rejects nested steps without retrying", async () => {
      const id = await create("custom-error");
      expect(await status(id, "errored")).toMatchObject({
        error: { name: "ApplicationFailure", message: "permanent custom error" },
      });
      expect(labels(id)).toEqual(["custom-error"]);
      expect(await status(await create("nested"), "errored")).toMatchObject({
        error: { message: "Workflow steps cannot be nested" },
      });
    });

    it("supports batch creation, native retention options and batch deletion results", async () => {
      const id = crypto.randomUUID();
      expect(await call("batch", id)).toEqual({ ids: [`${id}-a`, `${id}-b`] });
      await status(`${id}-a`, "complete");
      await status(`${id}-b`, "complete");
      expect(await call("deleteBatch", id)).toEqual({
        deleted: [{ id: `${id}-a` }, { id: `${id}-a` }, { id: `${id}-b` }],
        errors: [
          { id: `${id}-missing`, code: 10400, message: "workflows.api.error.instance.not_found" },
        ],
      });
    });

    it("exposes structured-clone outputs through JSON management queries", async () => {
      const id = await create("output");
      await vi.waitFor(async () => {
        expect(await manage({ action: "status", workflow: "fixture", id })).toMatchObject({
          result: {
            status: "complete",
            output: {
              integer: { $type: "BigInt", value: "42" },
              map: { $type: "Map", entries: [["key", 7]] },
            },
          },
        });
      });
    });

    it.each(["binding", "management"])(
      "deletes expired instances through %s and releases their IDs",
      async (source) => {
        const id = await create("loop", { expire: "1" });
        await vi.waitFor(async () => {
          const listed = z
            .object({
              result: z.object({
                instances: z.array(z.object({ id: z.string(), status: z.string() })),
              }),
            })
            .parse(await manage({ action: "list", workflow: "fixture" }));

          expect(listed.result.instances.find((instance) => instance.id === id)?.status).toBe(
            "expired",
          );
        });

        if (source === "binding") expect(await call("delete", id)).toEqual({ ok: true });
        else
          expect(await manage({ action: "delete", workflow: "fixture", id })).toEqual({
            result: null,
          });
        expect(await call("create", id, { mode: "loop" })).toEqual({ id });
        expect(await status(id, "complete")).toMatchObject({ output: 3 });
      },
    );

    it("purges instances and rejects further creation before app removal", async () => {
      const id = await create("sequential");
      await status(id, "waiting");
      expect(await manage({ action: "purge" })).toEqual({ result: { done: true } });
      await expect(call("create", crypto.randomUUID(), { mode: "sequential" })).rejects.toThrow(
        "being deleted",
      );
    });
  },
);
