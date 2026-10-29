import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { publishedApp, appSecretPreparation } from "@platform/contracts";
import { encodeConfiguration } from "@platform/auth-proxy/publication";
import { runtimeIdentity } from "./runtime-identity.ts";
import { z } from "zod";
import type { TestHarness } from "wrangler";
import { executionProfiles, executionRecorder } from "./cloudflare/execution-limits.fixture.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const hash = (source: string) => createHash("sha256").update(source).digest("hex");

const sourceId = crypto.randomUUID();

const targetId = crypto.randomUUID();

const token = "app-service-test-management-token-never-deploy";

const source = `import {WorkerEntrypoint} from 'cloudflare:workers';
export default class Source extends WorkerEntrypoint {
  read() { return this.env.TARGET.read(); }
  slow() { return this.env.TARGET.slow(); }
  fetch(request) { return this.env.TARGET.fetch(request); }
  secret() { return this.env.WIDEFLEET_SECRETS.get('TOKEN'); }
  root() { return this.env.WIDEFLEET_SECRETS_KEY ?? null; }
}`;

const target = (version: string) => `import {WorkerEntrypoint} from 'cloudflare:workers';
export class Reader extends WorkerEntrypoint {
  async read() { return {version:${JSON.stringify(version)}, secret:await this.env.WIDEFLEET_SECRETS.get('TOKEN')}; }
  async slow() { await this.env.KV.put('started','yes'); while (!await this.env.KV.get('release')) await new Promise(resolve=>setTimeout(resolve,10)); return this.read(); }
  fetch() { return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(${JSON.stringify(version)}));controller.close();}})); }
}
`;

const snapshot = (appId: string, source: string, version = "v1") =>
  publishedApp.parse({
    id: crypto.randomUUID(),
    appId,
    organizationId: "widefleet",
    version: crypto.randomUUID(),
    deploymentId: crypto.randomUUID(),
    hostname: `${appId}.apps.example.test`,
    secretRevision: appId === targetId ? (version === "v1" ? 1 : 2) : 0,
    metadata: {
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      web: false,
      entrypoints: appId === sourceId ? ["default"] : ["Reader"],
      bindings: appId === targetId ? [{ type: "kv_namespace", name: "KV", id: "state" }] : [],
      assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
    },
    modules: [
      { name: "worker.js", type: "esm", sha256: hash(source), size: Buffer.byteLength(source) },
    ],
    manifest: {},
    nativeBindings: appId === targetId ? { KV: "STATE" } : {},
    capabilities:
      appId === sourceId
        ? {
            TARGET: {
              organizationId: "widefleet",
              app: targetId,
              hostname: `${targetId}.apps.example.test`,
              entrypoint: "Reader",
            },
          }
        : {},
    network: { revision: 1, policy: { backend: [], browser: [] } },
  });

describe.runIf(process.env["RUN_SERVICE_TESTS"] === "1").each(["workerd", "celld"])(
  "App-to-app runtime on %s",
  (backend) => {
    let directory: string;
    let harness: TestHarness | undefined;
    let native: ReturnType<typeof spawn> | undefined;
    let origin: string;

    const request = (
      path: string,
      body?:
        | { app: z.infer<typeof publishedApp>; source: string }
        | z.infer<typeof appSecretPreparation>
        | { key: string }
        | { availability: "blocked" | "clear" | "unavailable" },
    ) =>
      (harness ? harness.fetch : fetch)(
        `${origin}${path}`,
        body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
      );

    const publish = async (
      appId: string,
      code: string,
      version = "v1",
      changes: Partial<z.infer<typeof publishedApp>> = {},
    ) => {
      const app = { ...snapshot(appId, code, version), ...changes };
      const response = await request("/seed", { app, source: code });
      expect(response.status).toBe(200);

      return app;
    };

    const secrets = async (revision: number, value: string) => {
      const response = await request("/secrets", {
        appId: targetId,
        revision,
        values: { TOKEN: value },
      });

      expect(response.status, await response.text()).toBe(200);
    };

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-app-services-"));
      const identity = await runtimeIdentity();
      const encrypted = await encodeConfiguration(token, identity.configuration);
      await writeFile(
        join(directory, "runtime.js"),
        await readFile(join(root, "packages/app-runtime/dist/loader.js")),
      );
      await writeFile(
        join(directory, "fixture.js"),
        `
import * as workers from 'cloudflare:workers';
import runtime, {AppService as Service} from './runtime.js'; export * from './runtime.js';
${executionRecorder}
export class AppService extends Service { constructor(ctx, env) { super(ctx, recordExecution(env)); } }
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  try {
    if(url.pathname === '/executions') return Response.json(executions);
    if(url.pathname === '/seed') {
      const {app,source} = await request.json();
      await env.WIDEFLEET_PACKAGES.put('apps/'+app.appId+'/modules/'+app.modules[0].sha256,source);
      await env.WIDEFLEET_PACKAGES.put('hosts/'+app.hostname+'.json',JSON.stringify(app));
      await env.AUTH_CONFIG.put('organizations/widefleet/configuration',${JSON.stringify(encrypted)});
      await env.AUTH_CONFIG.put('apps/'+app.hostname, JSON.stringify({organizationId:'widefleet',appId:app.appId,access:{revision:1,groups:[]}}));
      return Response.json(true);
    }
    if(url.pathname === '/availability') { const {availability}=await request.json(); await env.AUTH_CONFIG.put('organizations/widefleet/http-availability',availability==='unavailable' ? 'invalid' : JSON.stringify({blocked:availability==='blocked'})); return Response.json(true); }
    if(url.pathname === '/secrets') return ctx.exports.RuntimeManagement({props:{}}).fetch(new Request('https://runtime.internal/.well-known/widefleet/app-secrets',request));
    if(url.pathname === '/signal') { const input=await request.json(); await env.STATE.put(input.key,'yes'); return Response.json(true); }
    if(url.pathname === '/started') return Response.json(await env.STATE.get('started'));
    if(url.pathname === '/stored') {const result=[];for(const object of (await env.WIDEFLEET_PACKAGES.list({prefix:'app-secrets/'})).objects) result.push(await (await env.WIDEFLEET_PACKAGES.get(object.key)).text()); return Response.json(result);}
    if(url.pathname === '/web') {const headers=new Headers({cookie:${JSON.stringify(identity.cookie)}}); return runtime.fetch(new Request('https://${targetId}.apps.example.test/',{headers}),env,ctx);}
    const service=ctx.exports.AppService({props:{organizationId:'widefleet',app:${JSON.stringify(sourceId)},hostname:'${sourceId}.apps.example.test',entrypoint:'default'}});
    if(url.pathname === '/fetch') return await service.fetch(new Request('https://service.invalid/'));
    return Response.json(await service.invoke(url.pathname.slice(1),[]));
  } catch { return new Response('Rejected', {status:409}); }
}};`,
      );
      await build({
        entryPoints: [join(directory, "fixture.js")],
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
          name: "app-service-test",
          main: "bundle.js",
          no_bundle: true,
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          vars: {
            WIDEFLEET_EXECUTION_LIMITS: JSON.stringify(executionProfiles),
            WIDEFLEET_HTTP_AVAILABILITY: "kv",
            WIDEFLEET_CONTROL_TOKEN: token,
            WIDEFLEET_SECRETS_KEY: "ab".repeat(32),
            WIDEFLEET_CONFIGURATION: '{"crons":{},"queues":{}}',
          },
          worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
          r2_buckets: [{ binding: "WIDEFLEET_PACKAGES", bucket_name: "packages" }],
          kv_namespaces: [
            { binding: "AUTH_CONFIG", id: "auth" },
            { binding: "STATE", id: "state" },
          ],
        }),
      );

      if (backend === "workerd") {
        const { createTestHarness } = await import("wrangler");
        harness = createTestHarness({
          workers: [{ configPath: join(directory, "wrangler.json") }],
        });
        origin = String((await harness.listen()).url).replace(/\/$/, "");
      } else {
        const reservation = createServer();
        reservation.listen(0, "127.0.0.1");
        await once(reservation, "listening");
        const port = z.object({ port: z.number() }).parse(reservation.address()).port;
        await new Promise<void>((resolve, reject) =>
          reservation.close((error) => (error ? reject(error) : resolve())),
        );
        native = spawn(
          join(root, ".tools/celld"),
          ["dev", directory, "--port", String(port), "--no-watch"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        native.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        native.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        origin = `http://127.0.0.1:${port}`;
        await vi.waitFor(
          async () => {
            if (native?.exitCode !== null) throw new Error(output);
            expect((await fetch(`${origin}/.well-known/celld/health`)).ok).toBe(true);
          },
          { timeout: 20000 },
        );
      }

      await secrets(1, "synthetic-one");
      await publish(targetId, target("v1"));
      await publish(sourceId, source);
    }, 30000);
    afterAll(async () => {
      await harness?.close();

      if (native && native.exitCode === null) {
        const exited = once(native, "exit");
        native.kill("SIGTERM");
        const timeout = setTimeout(() => native?.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timeout);
      }

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("calls a named API through another app and streams fetch responses", async () => {
      expect(await (await request("/read")).json()).toEqual({
        version: "v1",
        secret: "synthetic-one",
      });
      expect(await (await request("/fetch")).text()).toBe("v1");
      expect((await request("/web")).status).toBe(404);
    });
    it("passes service execution budgets to both RPC and fetch invocations of cached apps", async () => {
      await request("/read");
      await request("/fetch");

      const executions = z
        .array(
          z.object({
            entrypoint: z.string().nullable(),
            limits: z.object({ cpuMs: z.number(), subRequests: z.number() }),
          }),
        )
        .parse(await (await request("/executions")).json());

      expect(executions.length).toBeGreaterThanOrEqual(4);
      expect(executions.some((entry) => entry.entrypoint === "Reader")).toBe(true);

      for (const execution of executions)
        expect(execution.limits).toEqual(executionProfiles.service);
    });
    it("does not expose provider or platform secrets to the consumer", async () => {
      expect((await request("/secret")).status).toBe(409);
      expect(await (await request("/root")).json()).toBeNull();
      expect(await (await request("/stored")).text()).not.toContain("synthetic-one");
    });
    it("pins in-flight code and secrets while new calls switch to the active version", async () => {
      const pending = request("/slow");
      await vi.waitFor(async () => expect(await (await request("/started")).json()).toBe("yes"));
      await secrets(2, "synthetic-two");
      await publish(targetId, target("v2"), "v2");
      expect(await (await request("/read")).json()).toEqual({
        version: "v2",
        secret: "synthetic-two",
      });
      await request("/signal", { key: "release" });
      expect(await (await pending).json()).toEqual({ version: "v1", secret: "synthetic-one" });
    });
    it("blocks cached service invocations while the organization is suspended or unreadable", async () => {
      expect((await request("/read")).status).toBe(200);

      for (const availability of ["blocked", "unavailable"] as const) {
        await request("/availability", { availability });
        expect((await request("/read")).status).toBe(409);
        expect((await request("/fetch")).status).toBe(409);
      }

      await request("/availability", { availability: "clear" });
      expect((await request("/read")).status).toBe(200);
    });
    it("rejects cross-organization targets, unpublished APIs and removed grants", async () => {
      await publish(targetId, target("v2"), "v2", { organizationId: "other" });
      expect((await request("/read")).status).toBe(409);
      const metadata = snapshot(targetId, target("v2"), "v2").metadata;
      await publish(targetId, target("v2"), "v2", { metadata: { ...metadata, entrypoints: [] } });
      expect((await request("/read")).status).toBe(409);
      await publish(targetId, target("v2"), "v2");
      await publish(sourceId, source, "v1", { capabilities: {} });
      expect((await request("/read")).status).toBe(409);
    });
  },
);
