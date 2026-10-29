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
import { hashAsset } from "../src/lib/server/asset-hash.ts";
import { z } from "zod";
import type { TestHarness } from "wrangler";
import { executionProfiles, executionRecorder } from "./cloudflare/execution-limits.fixture.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const hash = (source: string) => createHash("sha256").update(source).digest("hex");

const sourceId = crypto.randomUUID();

const targetId = crypto.randomUUID();

const identitySourceId = crypto.randomUUID();

const relayId = crypto.randomUUID();

const identityTargetId = crypto.randomUUID();

const identitySource = (
  handler: "object" | "class",
) => `import {WorkerEntrypoint} from 'cloudflare:workers';
async function handle(request, env, ctx) {
  const path=new URL(request.url).pathname;
  if(path==='/proof') return new Response(ctx.props.appCaller);
  if(path==='/forge') return Response.json(await env.WIDEFLEET_SERVICE_RELAY.invoke('who',[],request.headers.get('test-proof') ?? 'forged'));
  if(path==='/fake-caller') ctx.props.caller={issuer:'https://forged.invalid',subject:'bob',name:'Forged'};
  if(path==='/fetch') return env.RELAY.fetch(new Request('https://relay.invalid/',{headers:{'x-auth-request-user':'forged','x-widefleet-app-caller':'forged'}}));
  return Response.json(await env.RELAY.who());
}
${handler === "object" ? "export default {fetch:handle};" : "export default class Source extends WorkerEntrypoint {fetch(request){return handle(request,this.env,this.ctx);}}"}`;

const identityRelay = `import {WorkerEntrypoint} from 'cloudflare:workers';
class Base extends WorkerEntrypoint {
  async who() { await new Promise(resolve=>setTimeout(resolve,10)); return {relay:this.ctx.props.caller,final:await this.env.FINAL.who()}; }
  async fetch(request) { const result=await this.env.FINAL.fetch(request); return Response.json({relay:this.ctx.props.caller,final:await result.json()}); }
}
export class Relay extends Base {}`;

const identityTarget = `import {WorkerEntrypoint} from 'cloudflare:workers';
export class Identity extends WorkerEntrypoint {
  #marker='private-field';
  async who() { await new Promise(resolve=>setTimeout(resolve,10)); return {caller:this.ctx.props.caller,marker:this.#marker}; }
  fetch(request) { return Response.json({caller:this.ctx.props.caller,claimed:request.headers.get('x-auth-request-user'),transported:request.headers.get('x-widefleet-app-caller')}); }
}`;

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
    let identityIssuer: string;

    const request = (
      path: string,
      body?:
        | { app: z.infer<typeof publishedApp>; source: string; assets: Record<string, string> }
        | z.infer<typeof appSecretPreparation>
        | { key: string }
        | { availability: "blocked" | "clear" | "unavailable" },
      headers: Record<string, string> = {},
    ) =>
      (harness ? harness.fetch : fetch)(
        `${origin}${path}`,
        body === undefined ? { headers } : { method: "POST", body: JSON.stringify(body), headers },
      );

    const publish = async (
      appId: string,
      code: string,
      version = "v1",
      changes: Partial<z.infer<typeof publishedApp>> = {},
      assets: Record<string, string> = {},
    ) => {
      const app = { ...snapshot(appId, code, version), ...changes };
      const response = await request("/seed", { app, source: code, assets });
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
      const identity = await runtimeIdentity("apps.example.test", [], [], "bob");
      identityIssuer =
        identity.configuration.provider.type === "oidc"
          ? identity.configuration.provider.issuer
          : "";
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
      const {app,source,assets} = await request.json();
      await env.WIDEFLEET_PACKAGES.put('apps/'+app.appId+'/modules/'+app.modules[0].sha256,source);
      for(const [path,content] of Object.entries(assets)) await env.WIDEFLEET_PACKAGES.put('apps/'+app.appId+'/assets/'+app.manifest[path].hash,content);
      await env.WIDEFLEET_PACKAGES.put('hosts/'+app.hostname+'.json',JSON.stringify(app));
      await env.AUTH_CONFIG.put('organizations/widefleet/configuration',${JSON.stringify(encrypted)});
      await env.AUTH_CONFIG.put('apps/'+app.hostname, JSON.stringify({organizationId:'widefleet',appId:app.appId,access:{revision:1,groups:[]}}));
      return Response.json(true);
    }
    if(url.pathname === '/availability') { const {availability}=await request.json(); await env.AUTH_CONFIG.put('organizations/widefleet/http-availability',availability==='unavailable' ? 'invalid' : JSON.stringify({blocked:availability==='blocked'})); return Response.json(true); }
    if(url.pathname === '/secrets') return ctx.exports.RuntimeManagement({props:{}}).fetch(new Request('https://runtime.internal/.well-known/widefleet/app-secrets',request));
    if(url.pathname === '/ready') return ctx.exports.RuntimeManagement({props:{}}).fetch(new Request('https://${identitySourceId}.apps.example.test/.well-known/widefleet/ready'));
    if(url.pathname === '/signal') { const input=await request.json(); await env.STATE.put(input.key,'yes'); return Response.json(true); }
    if(url.pathname === '/started') return Response.json(await env.STATE.get('started'));
    if(url.pathname === '/stored') {const result=[];for(const object of (await env.WIDEFLEET_PACKAGES.list({prefix:'app-secrets/'})).objects) result.push(await (await env.WIDEFLEET_PACKAGES.get(object.key)).text()); return Response.json(result);}
    if(url.pathname === '/web') {const headers=new Headers({cookie:${JSON.stringify(identity.cookie)}}); return runtime.fetch(new Request('https://${targetId}.apps.example.test/',{headers}),env,ctx);}
    if(url.pathname.startsWith('/identity/')) {
      const headers=new Headers(request.headers);
      headers.set('cookie',url.searchParams.get('user')==='bob' ? ${JSON.stringify(identity.otherCookie)} : ${JSON.stringify(identity.cookie)});
      headers.set('x-auth-request-user','forged');
      return await runtime.fetch(new Request('https://${identitySourceId}.apps.example.test/'+url.pathname.slice('/identity/'.length),{headers,method:request.method}),env,ctx);
    }
    if(url.pathname==='/anonymous') return Response.json(await ctx.exports.AppService({props:{sourceAppId:'${identitySourceId}',organizationId:'widefleet',app:'${relayId}',hostname:'${relayId}.apps.example.test',entrypoint:'Relay'}}).invoke('who',[]));
    const service=ctx.exports.AppService({props:{organizationId:'widefleet',app:${JSON.stringify(sourceId)},hostname:'${sourceId}.apps.example.test',entrypoint:'default'}});
    if(url.pathname === '/fetch') return await service.fetch(new Request('https://service.invalid/'));
    return Response.json(await service.invoke(url.pathname.slice(1),[]));
  } catch (cause) { return new Response(String(cause), {status:409}); }
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

    it("admits concurrent cold service calls and streams fetch responses", async () => {
      const responses = await Promise.all(Array.from({ length: 8 }, () => request("/read")));

      for (const response of responses) {
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toEqual({ version: "v1", secret: "synthetic-one" });
      }

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

    it.each(["object", "class"] as const)(
      "preserves SSO identity across HTTP and named RPC hops with %s handlers",
      async (handler) => {
        const grant = (app: string, entrypoint: string) => ({
          app,
          entrypoint,
          organizationId: "widefleet",
          hostname: `${app}.apps.example.test`,
        });

        const metadata = (entrypoints: string[], web = false) => ({
          ...snapshot(identityTargetId, identityTarget).metadata,
          entrypoints,
          web,
        });

        await publish(identityTargetId, identityTarget, "v1", { metadata: metadata(["Identity"]) });
        await publish(relayId, identityRelay, "v1", {
          metadata: metadata(["Relay"]),
          capabilities: { FINAL: grant(identityTargetId, "Identity") },
        });
        await publish(identitySourceId, identitySource(handler), "v1", {
          metadata: metadata(["default"], true),
          capabilities: { RELAY: grant(relayId, "Relay") },
        });
        const alice = { issuer: identityIssuer, subject: "pairwise-subject", name: "Example User" };
        const bob = { ...alice, subject: "bob" };

        const calls = await Promise.all(
          Array.from({ length: 8 }, async (_, index) => {
            const user = index % 2 ? bob : alice;
            const response = await request(`/identity/who?user=${index % 2 ? "bob" : "alice"}`);

            return { user, status: response.status, body: await response.text() };
          }),
        );

        expect(
          calls.map((call) => call.status),
          JSON.stringify(calls),
        ).toEqual(Array(8).fill(200));

        for (const call of calls)
          expect(JSON.parse(call.body)).toEqual({
            relay: call.user,
            final: { caller: call.user, marker: "private-field" },
          });
        expect(await (await request("/identity/fetch")).json()).toEqual({
          relay: alice,
          final: { caller: alice, claimed: null, transported: null },
        });
        expect(await (await request("/identity/fake-caller")).json()).toEqual({
          relay: alice,
          final: { caller: alice, marker: "private-field" },
        });
        expect((await request("/identity/forge")).status).toBe(409);
        expect(await (await request("/anonymous")).json()).toEqual({
          relay: null,
          final: { caller: null, marker: "private-field" },
        });

        // A service cannot replay the source app's proof through its own binding.
        const sourceProof = await (await request("/identity/proof")).text();
        const replay = `import {WorkerEntrypoint} from 'cloudflare:workers'; export class Relay extends WorkerEntrypoint {who(){return this.env.WIDEFLEET_SERVICE_FINAL.invoke('who',[],${JSON.stringify(sourceProof)});}}`;
        await publish(relayId, replay, "v1", {
          metadata: metadata(["Relay"]),
          capabilities: { FINAL: grant(identityTargetId, "Identity") },
        });
        expect((await request("/identity/who")).status).toBe(409);
      },
      15_000,
    );

    it("carries the caller through object-style service RPC", async () => {
      const metadata = snapshot(relayId, identityRelay).metadata;
      await publish(identityTargetId, identityTarget, "v1", {
        metadata: { ...metadata, entrypoints: ["Identity"] },
      });
      await publish(relayId, `export default {who(_arg,env,ctx){return env.FINAL.who();}};`, "v1", {
        metadata: { ...metadata, entrypoints: ["default"] },
        capabilities: {
          FINAL: {
            organizationId: "widefleet",
            app: identityTargetId,
            hostname: `${identityTargetId}.apps.example.test`,
            entrypoint: "Identity",
          },
        },
      });
      await publish(
        identitySourceId,
        identitySource("object").replace("env.RELAY.who()", "env.RELAY.who(null)"),
        "v1",
        {
          metadata: { ...metadata, web: true, entrypoints: ["default"] },
          capabilities: {
            RELAY: {
              organizationId: "widefleet",
              app: relayId,
              hostname: `${relayId}.apps.example.test`,
              entrypoint: "default",
            },
          },
        },
      );
      const response = await request("/identity/who?user=bob");
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({
        caller: { issuer: identityIssuer, subject: "bob", name: "Example User" },
        marker: "private-field",
      });
    });
    it("keeps generated helper names and JavaScript keywords available as service exports", async () => {
      const names = ["app", "workers", "callerEntrypoint", "App_Reader", "class"];

      const code = `import {WorkerEntrypoint} from 'cloudflare:workers';
        class Reader extends WorkerEntrypoint {read(){return this.env.WIDEFLEET_ORIGIN;}}
        export {${names.map((name) => `Reader as ${name}`).join(",")}};`;

      const target = await publish(identityTargetId, code, "v1", {
        origin: `https://${identityTargetId}.apps.example.test:25453`,
        metadata: { ...snapshot(identityTargetId, code).metadata, entrypoints: names },
      });

      const bindings = names.map(
        (entrypoint, index) =>
          [
            `SERVICE_${index}`,
            {
              app: target.appId,
              hostname: target.hostname,
              organizationId: "widefleet",
              entrypoint,
            },
          ] as const,
      );

      const reader = `import {WorkerEntrypoint} from 'cloudflare:workers'; export default class extends WorkerEntrypoint {async read(){return Promise.all(${JSON.stringify(bindings.map(([name]) => name))}.map(name=>this.env[name].read()));}}`;
      await publish(sourceId, reader, "v1", { capabilities: Object.fromEntries(bindings) });
      const response = await request("/read");
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual(names.map(() => target.origin));
    });

    it("loads helper function exports alongside HTTP and inherited service entrypoints", async () => {
      const code = `import {WorkerEntrypoint} from 'cloudflare:workers';
        export async function asyncHelper(){return 'async';}
        export const arrowHelper=()=> 'arrow';
        export function syncHelper(){return 'sync';}
        class Base extends WorkerEntrypoint {
          async read(){return [await asyncHelper(),arrowHelper(),syncHelper()];}
        }
        export class Reader extends Base {}
        export default {async fetch(request,env,ctx){return Response.json({values:[await asyncHelper(),arrowHelper(),syncHelper()],caller:ctx.props.caller});}};`;

      const app = await publish(identitySourceId, code, "v1", {
        metadata: {
          ...snapshot(identitySourceId, code).metadata,
          web: true,
          entrypoints: ["Reader", "arrowHelper", "asyncHelper", "default", "syncHelper"],
        },
      });

      const ready = await request("/ready");
      expect(ready.status, await ready.clone().text()).toBe(200);
      expect(await ready.json()).toMatchObject({ deploymentId: app.deploymentId });

      const response = await request("/identity/helpers");
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({
        values: ["async", "arrow", "sync"],
        caller: { issuer: identityIssuer, subject: "pairwise-subject", name: "Example User" },
      });

      await publish(sourceId, source, "v1", {
        capabilities: {
          TARGET: {
            app: app.appId,
            hostname: app.hostname,
            organizationId: "widefleet",
            entrypoint: "Reader",
          },
        },
      });
      const rpc = await request("/read");
      expect(rpc.status, await rpc.clone().text()).toBe(200);
      expect(await rpc.json()).toEqual(["async", "arrow", "sync"]);
    });

    it("serves static assets and returns 404 for missing assets without a default handler", async () => {
      const code = "export {};";
      const content = "Static app";
      await publish(
        identitySourceId,
        code,
        "v1",
        {
          metadata: { ...snapshot(identitySourceId, code).metadata, web: true, entrypoints: [] },
          manifest: {
            "/present.txt": {
              hash: hashAsset("present.txt", Buffer.from(content)),
              size: Buffer.byteLength(content),
            },
          },
        },
        { "/present.txt": content },
      );
      expect((await request("/ready")).status).toBe(200);
      const present = await request("/identity/present.txt");
      expect(present.status).toBe(200);
      expect(await present.text()).toBe(content);

      for (const method of ["GET", "HEAD", "POST"]) {
        const missing = await (harness ? harness.fetch : fetch)(`${origin}/identity/missing.txt`, {
          method,
        });

        expect(missing.status, `${method}: ${await missing.text()}`).toBe(404);
      }
    });
  },
);
