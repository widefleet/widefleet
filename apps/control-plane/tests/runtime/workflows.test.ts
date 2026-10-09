import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

// These probes distinguish native Workflow support from the RPC features
// needed to execute an app Workflow inside its existing Dynamic Worker.
describe.runIf(process.env["RUN_DYNAMIC_TESTS"] === "1")(
  "Workflow compatibility on pinned celld",
  () => {
    let directory: string;
    let processHandle: ReturnType<typeof spawn>;
    let origin: string;
    let runtimeLogs = "";

    const stop = async () => {
      if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
        const exited = once(processHandle, "exit");
        processHandle.kill("SIGTERM");
        const timeout = setTimeout(() => processHandle.kill("SIGKILL"), 15000);
        await exited;
        clearTimeout(timeout);
      }
    };

    const start = async () => {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const { port } = z.object({ port: z.number() }).parse(reservation.address());
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

    const call = async (path: string) => {
      const response = await fetch(`${origin}${path}`);
      expect(response.ok).toBe(true);

      return z.json().parse(await response.json());
    };

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-workflow-test-"));

      const app = `import { WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers';
        export class AppWorkflow extends WorkflowEntrypoint {
          async run(event, step) {
            return step.do('value', async () => event.payload.value);
          }
        }
        export class Runner extends WorkerEntrypoint {
          ping() { return 'ready'; }
          double(value) { return value * 2; }
          run(event, step) { return new AppWorkflow(this.ctx, this.env).run(event, step); }
        }
        export default { fetch() { return new Response('ready'); } };`;

      await writeFile(
        join(directory, "index.js"),
        `import { WorkflowEntrypoint } from 'cloudflare:workers';
        function load(env) {
          return env.LOADER.get('synthetic-app', () => ({
            compatibilityDate: '2026-10-01',
            mainModule: 'app.js',
            modules: { 'app.js': ${JSON.stringify(app)} },
            globalOutbound: null,
          }));
        }
        export class NativeWorkflow extends WorkflowEntrypoint {
          async run(event, step) {
            const value = await step.do('value', async () => event.payload.value);
            await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
            return value;
          }
        }
        export class BridgeWorkflow extends WorkflowEntrypoint {
          async run(event, step) {
            return load(this.env).getEntrypoint('Runner').run(event, step);
          }
        }
        export class OrchestratedWorkflow extends WorkflowEntrypoint {
          async run(event, step) {
            const app = load(this.env).getEntrypoint('Runner');
            const value = await step.do('compute', () => app.double(event.payload.value));
            const next = await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
            return step.do('finish', () => app.double(value + next.payload.add));
          }
        }
        export default { async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === '/native/create') {
            const instance = await env.NATIVE.create({ id: 'native', params: { value: 42 } });
            return Response.json({ id: instance.id });
          }
          if (url.pathname === '/native/status') return Response.json(await (await env.NATIVE.get('native')).status());
          if (url.pathname === '/native/continue') {
            await (await env.NATIVE.get('native')).sendEvent({ type: 'continue', payload: {} });
            return Response.json({ sent: true });
          }
          if (url.pathname === '/dynamic/ping') return Response.json(await load(env).getEntrypoint('Runner').ping());
          if (url.pathname === '/dynamic/entrypoint') {
            try { return Response.json(await load(env).getEntrypoint('AppWorkflow').run({}, {})); }
            catch (error) { return Response.json({ name: error.name, message: error.message }); }
          }
          if (url.pathname === '/bridge/create') {
            const instance = await env.BRIDGE.create({ id: 'bridge', params: { value: 42 } });
            return Response.json({ id: instance.id });
          }
          if (url.pathname === '/bridge/status') return Response.json(await (await env.BRIDGE.get('bridge')).status());
          if (url.pathname === '/orchestrated/create') {
            const instance = await env.ORCHESTRATED.create({ id: 'orchestrated', params: { value: 10 } });
            return Response.json({ id: instance.id });
          }
          if (url.pathname === '/orchestrated/status') return Response.json(await (await env.ORCHESTRATED.get('orchestrated')).status());
          if (url.pathname === '/orchestrated/continue') {
            await (await env.ORCHESTRATED.get('orchestrated')).sendEvent({ type: 'continue', payload: { add: 1 } });
            return Response.json({ sent: true });
          }
          return new Response('Not found', { status: 404 });
        } };`,
      );
      await writeFile(
        join(directory, "wrangler.json"),
        JSON.stringify({
          name: "workflow-probe",
          main: "index.js",
          compatibility_date: "2026-10-01",
          no_bundle: true,
          worker_loaders: [{ binding: "LOADER" }],
          workflows: [
            { binding: "NATIVE", name: "native", class_name: "NativeWorkflow" },
            { binding: "BRIDGE", name: "bridge", class_name: "BridgeWorkflow" },
            { binding: "ORCHESTRATED", name: "orchestrated", class_name: "OrchestratedWorkflow" },
          ],
        }),
      );
      await start();
    }, 30000);

    afterAll(async () => {
      await stop();

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("resumes a native Workflow after restarting the runtime and receiving an event", async () => {
      expect(await call("/native/create")).toEqual({ id: "native" });
      await vi.waitFor(async () =>
        expect(await call("/native/status")).toMatchObject({ status: "waiting" }),
      );
      await stop();
      await start();
      expect(await call("/native/status")).toMatchObject({ status: "waiting" });
      expect(await call("/native/continue")).toEqual({ sent: true });
      await vi.waitFor(async () =>
        expect(await call("/native/status")).toMatchObject({ status: "complete", output: 42 }),
      );
    }, 30000);

    it("cannot resolve a WorkflowEntrypoint as a Dynamic Worker entrypoint", async () => {
      expect(await call("/dynamic/ping")).toBe("ready");

      const error = z
        .object({ name: z.string(), message: z.string() })
        .parse(await call("/dynamic/entrypoint"));

      expect(error.name).toBe("TypeError");
      expect(error.message).toContain("entrypoint name AppWorkflow was not found");
    });

    it("cannot transfer a native WorkflowStep to a Dynamic Worker RPC method", async () => {
      expect(await call("/bridge/create")).toEqual({ id: "bridge" });
      await vi.waitFor(async () => {
        const result = z
          .object({
            status: z.string(),
            error: z.object({ name: z.string(), message: z.string() }),
          })
          .parse(await call("/bridge/status"));

        expect(result.status).toBe("errored");
        expect(result.error.name).toBe("DataCloneError");
        expect(result.error.message).toContain("could not be cloned");
      });
    });

    it("orchestrates Dynamic Worker steps through native Workflows across a restart", async () => {
      expect(await call("/orchestrated/create")).toEqual({ id: "orchestrated" });
      await vi.waitFor(async () =>
        expect(await call("/orchestrated/status")).toMatchObject({ status: "waiting" }),
      );
      await stop();
      await start();
      expect(await call("/orchestrated/status")).toMatchObject({ status: "waiting" });
      expect(await call("/orchestrated/continue")).toEqual({ sent: true });
      await vi.waitFor(async () =>
        expect(await call("/orchestrated/status")).toMatchObject({
          status: "complete",
          output: 42,
        }),
      );
    }, 30000);
  },
);
