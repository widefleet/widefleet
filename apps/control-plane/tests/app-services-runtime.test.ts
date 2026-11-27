import { workloadToken } from "@platform/app-runtime/workload";
import { chromium } from "@playwright/test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import {
  publishedApp,
  appSecretPreparation,
  appAccessSnapshot,
  serviceDocumentation,
  runtimeRekeyInput,
} from "@platform/contracts";
import { encodeConfiguration } from "@platform/auth-proxy/publication";
import { verifyMcpCliLogin } from "@platform/auth-proxy/mcp-cli-login";
import { runtimeIdentity } from "./runtime-identity.ts";
import { hashAsset } from "../src/lib/server/asset-hash.ts";
import { z } from "zod";
import { rekeyRuntime } from "../src/lib/server/runtime-rekey.ts";
import type { TestHarness } from "wrangler";
import { executionProfiles, executionRecorder } from "./cloudflare/execution-limits.fixture.ts";
import { keySet, keyVersion } from "./keyring.fixture.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const hash = (source: string) => createHash("sha256").update(source).digest("hex");

const analyticsEvent = z.object({
  event: z.string(),
  distinct_id: z.string(),
  properties: z.record(z.string(), z.json()),
});

const analyticsBatch = z.object({ batch: z.array(analyticsEvent) });

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
  if(path==='/fetch') return env.RELAY.fetch(new Request('https://relay.invalid/',{headers:{'x-auth-request-user':'forged','x-widefleet-app-caller':'forged',origin:'https://target.apps.example.test','sec-fetch-site':'same-origin'}}));
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
  fetch(request) { return Response.json({caller:this.ctx.props.caller,claimed:request.headers.get('x-auth-request-user'),transported:request.headers.get('x-widefleet-app-caller'),origin:request.headers.get('origin'),site:request.headers.get('sec-fetch-site')}); }
}`;

const token = "app-service-test-management-token-never-deploy";

const source = `import {WorkerEntrypoint} from 'cloudflare:workers';
export default class Source extends WorkerEntrypoint {
  read() { return this.env.TARGET.read(); }
  slow() { return this.env.TARGET.slow(); }
  fetch(request) { return this.env.TARGET.fetch(request); }
  secret() { return this.env.WIDEFLEET_SECRETS.get('TOKEN'); }
  ask() { return this.env.TARGET.ask('offer-42'); }
  async answer() { const question=await this.env.TARGET.ask('offer-42'); return this.env.TARGET.withInput({inputResponses:{confirm:{action:'accept',content:{note:'ok'}}},requestState:question.requestState}).ask('offer-42'); }
  async misdirect() { const question=await this.env.TARGET.ask('offer-42'); return this.env.TARGET.withInput({inputResponses:{confirm:{action:'accept',content:{note:'ok'}}},requestState:question.requestState}).ask('offer-43'); }
  root() { return this.env.WIDEFLEET_SECRETS_KEYS ?? null; }
  async keys() { const keys=this.env.WIDEFLEET_KEYS; const sealed=await keys.encrypt('tokens','provider-access'); const signature=await keys.sign('cookies','session'); return {prefix:sealed.slice(0,3), opened:new TextDecoder().decode(await keys.decrypt('tokens',sealed)), verified:await keys.verify('cookies','session',signature), forged:await keys.verify('cookies','other',signature), foreign:await this.env.TARGET.open(sealed)}; }
  async identity() { return {own: await this.env.WIDEFLEET_IDENTITY.getToken('data-api', {appId: '${targetId}', organizationId: 'forged'}), target: await this.env.TARGET.identity(), key: this.env.WIDEFLEET_CONTROL_TOKEN ?? null}; }
}`;

const target = (version: string) => `import {WorkerEntrypoint} from 'cloudflare:workers';
export class Reader extends WorkerEntrypoint {
  identity() { return this.env.WIDEFLEET_IDENTITY.getToken('other-api'); }
  async open(sealed) { try { await this.env.WIDEFLEET_KEYS.decrypt('tokens', sealed); return 'opened'; } catch { return 'rejected'; } }
  async read() { return {version:${JSON.stringify(version)}, secret:await this.env.WIDEFLEET_SECRETS.get('TOKEN')}; }
  ask(offerId) {
    const input=this.ctx.props.input;
    if(!input) return {resultType:'input_required',inputRequests:{confirm:{message:'Send '+offerId+'?',requestedSchema:{type:'object',properties:{note:{type:'string'}},required:['note']}}},requestState:{seen:'private-offer-text'}};
    return {offerId,input,caller:this.ctx.props.caller?.subject ?? null};
  }
  picture() { return {contentType:'image/png', base64:'A'.repeat(2 * 1024 * 1024)}; }
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
    const analytics: z.infer<typeof analyticsEvent>[] = [];

    // Receives the runtime's PostHog batches instead of the real ingestion endpoint.
    const collector = createHttpServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const body = incoming.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes;
        analytics.push(...analyticsBatch.parse(JSON.parse(body.toString())).batch);
        response.writeHead(200).end("{}");
      });
    });

    const request = (
      path: string,
      body?:
        | {
            app: z.infer<typeof publishedApp>;
            source: string;
            assets: Record<string, string>;
            documentation?: z.input<typeof serviceDocumentation> | undefined;
          }
        | z.infer<typeof appSecretPreparation>
        | { key: string }
        | { identity: { appId: string; organizationId: string; hostname: string } }
        | { availability: "blocked" | "clear" | "unavailable" }
        | { hostname: string; appId: string; access: z.infer<typeof appAccessSnapshot> }
        | { subject: string; groups: string[] }
        | { hostname: string; refresh: boolean }
        | {
            hostname: string;
            route: {
              organizationId: string;
              appId: string;
              access: z.infer<typeof appAccessSnapshot>;
            };
          }
        | { count: number }
        | { drop: boolean }
        | { token: string }
        | { key: string; value: string }
        | z.infer<typeof runtimeRekeyInput>,
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
      documentation?: z.input<typeof serviceDocumentation>,
    ) => {
      const app = { ...snapshot(appId, code, version), ...changes };
      const response = await request("/seed", { app, source: code, assets, documentation });
      expect(response.status, await response.clone().text()).toBe(200);

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
      collector.listen(0, "127.0.0.1");
      await once(collector, "listening");
      const analyticsPort = z.object({ port: z.number() }).parse(collector.address()).port;
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
      await build({
        entryPoints: [join(root, "packages/app-runtime/fixtures/mcp-oauth.ts")],
        outfile: join(directory, "mcp-fixture.js"),
        bundle: true,
        format: "esm",
        platform: "neutral",
        conditions: ["workerd"],
        mainFields: ["module", "main"],
        external: ["cloudflare:*", "node:*"],
        logLevel: "silent",
      });
      await writeFile(
        join(directory, "fixture.js"),
        `
import * as workers from 'cloudflare:workers';
import {mcpFixture} from './mcp-fixture.js';
import runtime, {AppService as Service, WorkloadIdentity as Identity} from './runtime.js'; export * from './runtime.js';
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === 'https://platform.example.test' && url.pathname === '/healthz') return Promise.resolve(new Response(null, {status: 200}));
  if (url.origin === 'https://login.microsoftonline.com') return Promise.resolve(Response.json({error: 'invalid_tenant'}, {status: 400}));
  return originalFetch(url.origin === 'https://eu.i.posthog.com' ? new Request('http://127.0.0.1:${analyticsPort}'+url.pathname, request) : request);
};
${executionRecorder}
// A loader that has dropped every Worker it loaded, as the edge does when it evicts an idle one.
let dropWorkers = false;
const dropping = (loader) => ({get:(name,code)=>loader.get(name+'/'+crypto.randomUUID(),code)});
export class AppService extends Service { constructor(ctx, env) { super(ctx, recordExecution(dropWorkers ? {...env,WIDEFLEET_LOADER:dropping(env.WIDEFLEET_LOADER)} : env)); } }
export class UnconfiguredIdentity extends Identity { constructor(ctx, env) { super(ctx, {...env,WIDEFLEET_WORKLOAD_ISSUER:undefined}); } }
const refreshIndex = (ctx, hostname) => ctx.exports.RuntimeManagement({props:{}}).fetch(new Request('https://runtime.internal/.well-known/widefleet/service-index',{method:'POST',body:JSON.stringify({organizationId:'widefleet',hostname})}));
let publishDuringScan = null;
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  try {
    const fixture = await mcpFixture(request,env,ctx); if(fixture) return fixture;
    if(url.pathname === '/mcp' || url.pathname.startsWith('/oauth/') || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      const loader={get:env.WIDEFLEET_LOADER.get.bind(env.WIDEFLEET_LOADER),load(){throw new Error('MCP must not create a dynamic worker for scripts');}};
      let routes=env.AUTH_CONFIG;
      if(publishDuringScan) {
        // Publishes and refreshes a route after the search has listed the routes.
        const {hostname,route}=publishDuringScan; publishDuringScan=null;
        routes={get:env.AUTH_CONFIG.get.bind(env.AUTH_CONFIG),async list(options){const page=await env.AUTH_CONFIG.list(options);await env.AUTH_CONFIG.put('apps/'+hostname,JSON.stringify(route));const indexed=await refreshIndex(ctx,hostname);if(!indexed.ok) throw new Error('refresh '+indexed.status);return page;}};
      }
      return runtime.fetch(new Request('https://mcp.apps.example.test'+url.pathname,request),{...env,WIDEFLEET_LOADER:loader,AUTH_CONFIG:routes},ctx);
    }
    if(url.pathname === '/publish-during-next-scan') { publishDuringScan=await request.json(); return Response.json(true); }
    if(url.pathname === '/drop-workers') { dropWorkers=(await request.json()).drop; return Response.json(true); }
    if(url.pathname === '/drop-index') { await env.WIDEFLEET_PACKAGES.delete('service-index/widefleet.json'); return Response.json(true); }
    if(url.pathname === '/expire-index') { const object=await env.WIDEFLEET_PACKAGES.get('service-index/widefleet.json'); await env.WIDEFLEET_PACKAGES.put('service-index/widefleet.json',JSON.stringify({...await object.json(),builtAt:1})); return Response.json(true); }
    if(url.pathname === '/index') { const object=await env.WIDEFLEET_PACKAGES.get('service-index/widefleet.json'); return Response.json(object ? await object.json() : null); }
    if(url.pathname === '/foreign-routes') {
      const {count}=await request.json();
      for(let index=0;index<count;index++) await env.AUTH_CONFIG.put('apps/0-foreign-'+String(index).padStart(4,'0')+'.apps.example.test',JSON.stringify({organizationId:'other',appId:crypto.randomUUID(),access:{revision:1,groups:[]}}));
      return Response.json(true);
    }
    if(url.pathname === '/workload-proof' || url.pathname === '/unconfigured-identity') {
      const {identity}=await request.json();
      const binding=url.pathname === '/workload-proof' ? ctx.exports.WorkloadIdentity : ctx.exports.UnconfiguredIdentity;
      return Response.json(await binding({props:identity}).getToken('data-api'));
    }
    if(url.pathname.startsWith('/workload/')) return runtime.fetch(new Request((url.searchParams.get('origin') ?? 'https://auth.apps.example.test')+url.pathname),env,ctx);
    if(url.pathname === '/executions') return Response.json(executions);
    if(url.pathname === '/seed') {
      const {app,source,assets,documentation} = await request.json();
      await env.WIDEFLEET_PACKAGES.put('apps/'+app.appId+'/modules/'+app.modules[0].sha256,source);
      for(const [path,content] of Object.entries(assets)) await env.WIDEFLEET_PACKAGES.put('apps/'+app.appId+'/assets/'+app.manifest[path].hash,content);
      if(documentation) await env.WIDEFLEET_PACKAGES.put('apps/'+app.appId+'/service-documentation/'+app.id+'.json',JSON.stringify(documentation));
      await env.WIDEFLEET_PACKAGES.put('hosts/'+app.hostname+'.json',JSON.stringify(app));
      await env.AUTH_CONFIG.put('organizations/widefleet/configuration',${JSON.stringify(encrypted)});
      await env.AUTH_CONFIG.put('apps/'+app.hostname, JSON.stringify({organizationId:'widefleet',appId:app.appId,access:{revision:1,groups:[]}}));
      const indexed=await refreshIndex(ctx,app.hostname);
      if(!indexed.ok) return new Response(indexed.status+' '+await indexed.text(),{status:500});
      return Response.json(true);
    }
    if(url.pathname === '/unpublish') {
      const {hostname,refresh}=await request.json();
      await env.AUTH_CONFIG.delete('apps/'+hostname);
      if(refresh) await refreshIndex(ctx,hostname);
      return Response.json(true);
    }
    if(url.pathname === '/availability') { const {availability}=await request.json(); await env.AUTH_CONFIG.put('organizations/widefleet/http-availability',availability==='unavailable' ? 'invalid' : JSON.stringify({blocked:availability==='blocked'})); return Response.json(true); }
    if(url.pathname === '/secrets') return ctx.exports.RuntimeManagement({props:{}}).fetch(new Request('https://runtime.internal/.well-known/widefleet/app-secrets',request));
    if(url.pathname === '/rekey') return ctx.exports.RuntimeManagement({props:{}}).fetch(new Request('https://runtime.internal/.well-known/widefleet/rekey',request));
    if(url.pathname === '/put-stored') { const {key,value}=await request.json(); await env.WIDEFLEET_PACKAGES.put(key,value); return Response.json(true); }
    if(url.pathname === '/ready') return ctx.exports.RuntimeManagement({props:{}}).fetch(new Request('https://${identitySourceId}.apps.example.test/.well-known/widefleet/ready'));
    if(url.pathname === '/signal') { const input=await request.json(); await env.STATE.put(input.key,'yes'); return Response.json(true); }
    if(url.pathname === '/started') return Response.json(await env.STATE.get('started'));
    if(url.pathname === '/stored-keys') {const result=[];for(const object of (await env.WIDEFLEET_PACKAGES.list({prefix:'app-keys/'})).objects) result.push({key:object.key,value:await (await env.WIDEFLEET_PACKAGES.get(object.key)).json()}); return Response.json(result);}
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
            WIDEFLEET_SECRETS_KEYS: keySet(
              keyVersion("test", Buffer.alloc(32, 0xab).toString("base64url")),
            ),
            WIDEFLEET_WORKLOAD_ISSUER: "https://auth.apps.example.test/workload",
            WIDEFLEET_MCP_ORIGIN: "https://mcp.apps.example.test",
            WIDEFLEET_CONFIGURATION: '{"crons":{},"queues":{}}',
            POSTHOG_PROJECT_TOKEN: "phc_synthetic_fixture",
            POSTHOG_SCOPE: "fixture",
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
          process.env["CELLD_BINARY"] ?? join(root, ".tools/celld"),
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
      collector.close();

      if (native && native.exitCode === null) {
        const exited = once(native, "exit");
        native.kill("SIGTERM");
        const timeout = setTimeout(() => native?.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timeout);
      }

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("renders the shared Svelte sign-in with bundled styles and images without a control plane", async () => {
      const response = await request("/mcp-sign-in");
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("set-cookie")).toContain("__Host-");
      const html = await response.text();
      expect(html).toContain("Connect to Widefleet");
      expect(html).toContain("Local test client");
      expect(html).toContain('action="/oauth/continue"');
      expect(html).toContain('name="handle"');
      expect(html).toContain("data:image/svg+xml");
      expect(html).toContain("prefers-color-scheme:dark");
      expect(html).not.toContain("<script");
      expect(html).not.toContain('src="/');
      expect(html).not.toContain('<link rel="stylesheet"');
    });

    it.each([
      ["Continue with email", "https://platform.example.test", "guest@unknown.example.test"],
      ["Continue with Widefleet", "https://platform.example.test", ""],
      ["Cancel", "https://client.example.test", ""],
    ])(
      "submits %s in the browser and follows its OAuth redirect",
      async (button, destination, email) => {
        const browser = await chromium.launch();
        const destinationReferrers: (string | undefined)[] = [];

        const destinationServer = createHttpServer((request, response) => {
          destinationReferrers.push(request.headers.referer);
          response.setHeader("content-type", "text/html");
          response.end("OAuth destination reached");
        });

        destinationServer.listen(0, "127.0.0.1");
        await once(destinationServer, "listening");
        const { port } = z.object({ port: z.number() }).parse(destinationServer.address());
        const callback = `http://127.0.0.1:${port}/callback`;

        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(5000);
          const submittedOrigins: (string | undefined)[] = [];
          const redirects: string[] = [];

          await page.route("https://mcp.apps.example.test/**", async (route) => {
            const submitted = route.request();
            const path = new URL(submitted.url()).pathname;

            if (submitted.method() === "POST") submittedOrigins.push(submitted.headers()["origin"]);

            const response =
              path === "/authorize"
                ? await request("/mcp-sign-in")
                : await (harness ? harness.fetch : fetch)(`${origin}${path}`, {
                    method: submitted.method(),
                    headers: submitted.headers(),
                    body: submitted.postData(),
                    redirect: "manual",
                  });

            const headers = new Headers(Object.fromEntries(response.headers));
            const location = headers.get("location");

            if (location) {
              redirects.push(new URL(location).origin);
              // Keep redirects real browser navigations, but never contact an external provider.
              headers.set("location", callback);
            }

            await route.fulfill({
              status: response.status,
              headers: Object.fromEntries(headers),
              body: await response.text(),
            });
          });
          await page.goto("https://mcp.apps.example.test/authorize");

          // A domain without an organization falls back to Widefleet sign-in.
          if (email) await page.getByLabel("Work email").fill(email);

          await page.getByRole("button", { name: button, exact: true }).click();
          await page.waitForURL(callback);
          expect(await page.locator("body").innerText()).toBe("OAuth destination reached");
          expect(submittedOrigins).toEqual(["https://mcp.apps.example.test"]);
          expect(redirects).toEqual([destination]);
          expect(destinationReferrers).toEqual([undefined]);
        } finally {
          await browser.close();
          await new Promise<void>((resolve, reject) =>
            destinationServer.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
      20000,
    );

    it("serves MCP and interpreted code without a control plane, using app groups and revocation", async () => {
      const access = appAccessSnapshot.parse({ revision: 1, groups: ["readers"] });

      const setup = () =>
        request("/mcp-setup", {
          hostname: `${targetId}.apps.example.test`,
          appId: targetId,
          access,
        });

      const issue = async (
        subject = "alice",
        groups: string[] = subject === "alice" ? ["readers"] : [],
      ) => {
        const response = await request("/mcp-issue", { subject, groups });
        expect(response.status, await response.clone().text()).toBe(200);

        return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
      };

      await setup();
      const accessToken = await issue();

      const send = async (
        method: string,
        params: z.infer<ReturnType<typeof z.json>>,
        bearer = accessToken,
      ) => {
        const response = await (harness ? harness.fetch : fetch)(`${origin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `bEaReR ${bearer}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });

        expect(response.status, await response.clone().text()).toBe(200);
        const body = await response.text();

        const payload = response.headers.get("content-type")?.includes("text/event-stream")
          ? body
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6)
          : body;

        return z.json().parse(JSON.parse(payload ?? "null"));
      };

      const rpc = async (
        name: string,
        args: z.infer<ReturnType<typeof z.json>>,
        bearer = accessToken,
      ) =>
        z
          .object({
            result: z.object({
              isError: z.boolean().optional(),
              content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
            }),
          })
          .parse(await send("tools/call", { name, arguments: args }, bearer)).result;

      expect((await request("/mcp")).status).toBe(401);
      expect(
        await (await request("/.well-known/oauth-protected-resource/mcp")).json(),
      ).toMatchObject({
        resource: "https://mcp.apps.example.test/mcp",
        authorization_servers: ["https://mcp.apps.example.test"],
      });

      const skill = await readFile(
        join(root, "plugins/widefleet/skills/widefleet/SKILL.md"),
        "utf8",
      );

      const skillUri = "skill://widefleet/SKILL.md";

      const initialized = z
        .object({
          result: z.object({
            instructions: z.string(),
            capabilities: z.object({ extensions: z.record(z.string(), z.json()) }),
          }),
        })
        .parse(
          await send("initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          }),
        ).result;

      expect(initialized.instructions).toContain(skillUri);
      expect(initialized.instructions).toContain("Widefleet CLI in your shell");
      expect(initialized.capabilities.extensions).toHaveProperty("io.modelcontextprotocol/skills");

      expect(await send("skills/list", {})).toMatchObject({
        result: { skills: [{ uri: skillUri, frontmatter: { name: "widefleet" } }] },
      });

      expect(await send("resources/read", { uri: skillUri })).toMatchObject({
        result: { contents: [{ uri: skillUri, text: skill }] },
      });

      expect(JSON.parse((await rpc("skills", {})).content[0]?.text ?? "null")).toMatchObject({
        skills: [{ name: "widefleet", uri: skillUri }],
      });

      expect(
        JSON.parse((await rpc("skills", { name: "widefleet" })).content[0]?.text ?? "null"),
      ).toMatchObject({ name: "widefleet", uri: skillUri, content: skill });

      expect((await rpc("skills", { name: "missing" })).isError).toBe(true);

      const cliLogin = await rpc("cli_login", {});
      expect(cliLogin.isError, cliLogin.content[0]?.text).not.toBe(true);

      const { command } = z
        .object({ command: z.string() })
        .parse(JSON.parse(cliLogin.content[0]?.text ?? "null"));

      const [, loginCode] =
        /^widefleet login --url https:\/\/platform\.example\.test --code (\S+)$/.exec(command) ??
        [];

      expect(await verifyMcpCliLogin(token, z.string().parse(loginCode))).toMatchObject({
        organizationId: "widefleet",
        issuer: identityIssuer,
        subject: "alice",
      });

      const service = {
        hostname: `${targetId}.apps.example.test`,
        entrypoint: "Reader",
        method: "read",
        arguments: [],
      };

      const docs = serviceDocumentation.parse({
        format: 3,
        entrypoints: [
          {
            name: "Reader",
            summary: "Read inventory records",
            remarks: "",
            examples: [],
            http: true,
            methods: [
              {
                name: "read",
                summary: "Read one record",
                remarks: "",
                examples: [],
                throws: [],
                signatures: [
                  {
                    parameters: [
                      {
                        name: "limit",
                        type: "number",
                        description: "Result limit",
                        optional: true,
                        rest: false,
                      },
                    ],
                    returns: { type: "InventoryRecord", description: "The record" },
                    uses: ["InventoryRecord"],
                  },
                ],
              },
            ],
          },
        ],
        types: [
          {
            name: "InventoryRecord",
            kind: "type",
            definition: "{ version: string; secret: string }",
            summary: "A record",
            remarks: "",
            examples: [],
          },
        ],
      });

      const selection = {
        hostname: service.hostname,
        entrypoint: service.entrypoint,
        methods: [service.method],
      };

      const described = async () => {
        const response = await rpc("describe", selection);

        expect(response.isError, response.content[0]?.text).not.toBe(true);

        return z.json().parse(JSON.parse(response.content[0]?.text ?? "null"));
      };

      const undocumented = await rpc("describe", selection);
      expect(undocumented.isError).toBe(true);
      expect(undocumented.content[0]?.text).toContain("no API documentation");

      const documented = await publish(targetId, target("v1"), "v1", {}, {}, docs);

      await setup();
      expect(await described()).toMatchObject({
        documentation: docs.entrypoints[0],
        types: docs.types,
        omittedTypes: [],
      });

      const named = await rpc("describe", {
        hostname: service.hostname,
        entrypoint: service.entrypoint,
        types: ["InventoryRecord"],
      });

      expect(JSON.parse(named.content[0]?.text ?? "null")).toMatchObject({
        documentation: { name: "Reader", methods: [] },
        types: docs.types,
      });
      const missing = await rpc("describe", { ...selection, types: ["Missing"] });
      expect(missing.isError).toBe(true);
      expect(missing.content[0]?.text).toContain("no documented type Missing");
      const empty = await rpc("describe", { ...selection, methods: [] });
      expect(empty.isError).toBe(true);
      expect(empty.content[0]?.text).toContain("Name at least one method or type");
      const search = await rpc("search", { query: "inventory records" });
      expect(JSON.parse(search.content[0]?.text ?? "null")).toMatchObject({
        methods: [
          {
            hostname: service.hostname,
            entrypoint: "Reader",
            method: "read",
            summary: "Read one record",
          },
        ],
      });
      const unknown = await rpc("describe", { ...selection, methods: ["write"] });
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0]?.text).toContain("Search with this hostname and entrypoint");

      const denied = await rpc("describe", selection, await issue("bob"));

      expect(denied.isError).toBe(true);
      const hidden = await rpc("search", { limit: 50 }, await issue("bob"));
      expect(
        z
          .object({ methods: z.array(z.object({ hostname: z.string() })) })
          .parse(JSON.parse(hidden.content[0]?.text ?? "null"))
          .methods.map((entry) => entry.hostname),
      ).not.toContain(service.hostname);
      expect(
        (
          await rpc(
            "execute",
            {
              code: `return await tools.call(${JSON.stringify(service)});`,
            },
            await issue("bob"),
          )
        ).isError,
      ).toBe(true);

      const nextDocs = {
        ...docs,
        entrypoints: docs.entrypoints.map((entry) => ({ ...entry, summary: "New inventory API" })),
      };

      await publish(targetId, target("v1"), "v1", {}, {}, nextDocs);
      await setup();
      expect(await described()).toMatchObject({ documentation: { summary: "New inventory API" } });
      await request("/seed", {
        app: documented,
        source: target("v1"),
        assets: {},
        documentation: docs,
      });
      await setup();
      expect(await described()).toMatchObject({
        documentation: docs.entrypoints[0],
        types: docs.types,
        omittedTypes: [],
      });

      const called = await rpc("call", service);
      expect(called.isError).not.toBe(true);
      expect(JSON.parse(called.content[0]?.text ?? "null")).toMatchObject({ version: "v1" });

      // Protocol revision 2026-07-28 asks through input_required and a retry of the same call.
      const ask = { ...service, method: "ask", arguments: ["offer-42"] };

      const modern = async (
        retry: { requestState?: string; inputResponses?: z.infer<ReturnType<typeof z.json>> },
        bearer = accessToken,
        capabilities: z.infer<ReturnType<typeof z.json>> = { elicitation: { form: {} } },
      ) => {
        const response = await (harness ? harness.fetch : fetch)(`${origin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": "call",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "call",
              arguments: ask,
              ...retry,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": capabilities,
                "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
              },
            },
          }),
        });

        const body = await response.text();
        const line = body.split("\n").find((entry) => entry.startsWith("data: "));

        return z.json().parse(JSON.parse(line ? line.slice(6) : body));
      };

      const elicited = z
        .object({
          result: z.object({
            resultType: z.literal("input_required"),
            inputRequests: z.object({
              confirm: z.object({
                method: z.literal("elicitation/create"),
                params: z.object({ message: z.string() }).loose(),
              }),
            }),
            requestState: z.string(),
          }),
        })
        .parse(await modern({})).result;

      expect(elicited.inputRequests.confirm.params.message).toBe("Send offer-42?");
      expect(elicited.requestState).not.toContain("private-offer-text");

      const confirmed = z
        .object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) })
        .parse(
          await modern({
            requestState: elicited.requestState,
            inputResponses: { confirm: { action: "accept", content: { note: "ok" } } },
          }),
        ).result;

      expect(JSON.parse(confirmed.content[0]?.text ?? "null")).toEqual({
        offerId: "offer-42",
        input: {
          inputResponses: { confirm: { action: "accept", content: { note: "ok" } } },
          requestState: { seen: "private-offer-text" },
        },
        caller: "alice",
      });

      // State minted for alice does not answer for bob.
      expect(
        JSON.stringify(
          await modern(
            {
              requestState: elicited.requestState,
              inputResponses: { confirm: { action: "accept", content: { note: "ok" } } },
            },
            await issue("bob", ["readers"]),
          ),
        ),
      ).toContain("Invalid or expired input request state");

      // Clients without their own dialog get a form through the ask tool.
      const relayed = await rpc("call", ask);
      expect(relayed.isError).not.toBe(true);

      const relayedState = z
        .string()
        .parse(
          JSON.parse(relayed.content[0]?.text?.match(/requestState ("[^"]+")/)?.[1] ?? "null"),
        );

      const apps = {
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
      };

      expect(JSON.stringify(await modern({}, accessToken, apps))).toContain("Call the ask tool");
      expect(JSON.stringify(await modern({}, accessToken, {}))).toContain(
        "can show neither input dialogs nor MCP Apps forms",
      );

      const formTools = z
        .object({
          result: z.object({
            tools: z.array(z.object({ name: z.string(), _meta: z.json().optional() })),
          }),
        })
        .parse(await send("tools/list", {})).result.tools;

      expect(formTools.find((tool) => tool.name === "ask")?._meta).toMatchObject({
        ui: { resourceUri: "ui://widefleet/input-form.html" },
      });
      expect(formTools.find((tool) => tool.name === "answer")?._meta).toMatchObject({
        ui: { visibility: ["app"] },
      });
      expect(await send("resources/read", { uri: "ui://widefleet/input-form.html" })).toMatchObject(
        {
          result: {
            contents: [
              { uri: "ui://widefleet/input-form.html", mimeType: "text/html;profile=mcp-app" },
            ],
          },
        },
      );

      const tool = async (name: string, args: z.infer<ReturnType<typeof z.json>>) =>
        z
          .object({
            result: z.object({
              isError: z.boolean().optional(),
              content: z.array(z.object({ text: z.string() })),
              _meta: z
                .object({
                  "widefleet/input": z.object({
                    call: z.json(),
                    inputRequests: z.object({ confirm: z.object({ message: z.string() }) }),
                    requestState: z.string(),
                  }),
                })
                .optional(),
            }),
          })
          .parse(await send("tools/call", { name, arguments: args })).result;

      const form = (await tool("ask", { ...ask, requestState: relayedState }))._meta?.[
        "widefleet/input"
      ];

      expect(form?.call).toEqual(ask);
      expect(form?.inputRequests.confirm.message).toBe("Send offer-42?");
      expect(form?.requestState).not.toContain("private-offer-text");

      const inputResponses = { confirm: { action: "accept", content: { note: "ok" } } };

      const answered = await tool("answer", {
        ...ask,
        requestState: form?.requestState ?? "",
        inputResponses,
      });

      expect(JSON.parse(answered.content[0]?.text ?? "null")).toEqual({
        offerId: "offer-42",
        input: { inputResponses, requestState: { seen: "private-offer-text" } },
        caller: "alice",
      });

      // The state an agent sees in the call result does not answer through the form.
      const forged = await rpc("answer", { ...ask, requestState: relayedState, inputResponses });
      expect(forged.isError).toBe(true);
      expect(forged.content[0]?.text).toContain("Invalid or expired input request state");

      const executed = await rpc("execute", {
        code: `const first = await tools.call(${JSON.stringify(service)}); return {version:first.version, credentials:typeof process};`,
      });

      expect(executed.isError, executed.content[0]?.text).not.toBe(true);
      expect(JSON.parse(executed.content[0]?.text ?? "null")).toEqual({
        version: "v1",
        credentials: "undefined",
      });

      // A service's file reaches the client as an MCP block, past the 1 MiB JSON limit.
      const picture = await rpc("execute", {
        code: `const first = await tools.call(${JSON.stringify(service)}); const file = await tools.call(${JSON.stringify({ ...service, method: "picture" })}); return {version:first.version, image:{type:"image", mimeType:file.contentType, data:file.base64}};`,
      });

      expect(picture.isError, picture.content[0]?.text).not.toBe(true);
      expect(picture.content[0]).toEqual({
        type: "text",
        text: JSON.stringify({
          version: "v1",
          image: { type: "image", mimeType: "image/png", contentIndex: 1 },
        }),
      });
      expect(picture.content[1]).toEqual({
        type: "image",
        mimeType: "image/png",
        data: "A".repeat(2 * 1024 * 1024),
      });

      const outbound = await rpc("execute", {
        code: "return (await fetch('https://example.invalid/')).status;",
      });

      expect(outbound.isError || outbound.content[0]?.text === "403").toBe(true);

      const quota = await rpc("execute", {
        code: `for(let i=0;i<33;i++) await tools.call(${JSON.stringify(service)}); return true;`,
      });

      expect(quota.isError).toBe(true);
      expect((await rpc("execute", { code: 'return "x".repeat(1024 * 1024);' })).isError).toBe(
        true,
      );
      expect((await rpc("call", service, await issue("bob"))).isError).toBe(true);
      expect((await rpc("call", { ...service, method: "constructor" })).isError).toBe(true);
      access.groups = ["warehouse-readers"];
      await setup();
      expect(
        (await rpc("call", service, await issue("bob", ["warehouse-readers"]))).isError,
      ).not.toBe(true);
      expect((await rpc("call", service, await issue("bob", ["warehouse-writers"]))).isError).toBe(
        true,
      );
      access.groups = ["nobody"];
      await setup();
      expect((await rpc("call", service)).isError).toBe(true);

      access.groups = [];
      await setup();
      expect((await rpc("call", service, await issue("bob"))).isError).not.toBe(true);

      const entrypoints = Array.from({ length: 32 }, (_, index) => `Service${index}`);

      const largeDocs = serviceDocumentation.parse({
        format: 3,
        entrypoints: entrypoints.map((name) => ({
          name,
          summary: "",
          remarks: "",
          examples: [],
          http: false,
          methods: [
            {
              name: "read",
              summary: "x".repeat(7000) + "search-pagination-marker",
              remarks: "",
              examples: [],
              throws: [],
              signatures: [{ parameters: [], returns: { type: "void", description: "" } }],
            },
          ],
        })),
        types: [],
      });

      for (let index = 0; index < 12; index++) {
        const id = crypto.randomUUID();
        await publish(
          id,
          target("v1"),
          "v1",
          { metadata: { ...snapshot(id, target("v1")).metadata, entrypoints } },
          {},
          largeDocs,
        );
      }

      const searchPage = z.object({
        methods: z.array(
          z.object({
            hostname: z.string(),
            entrypoint: z.string(),
            method: z.string(),
            summary: z.string(),
          }),
        ),
        remaining: z.number(),
        next: z.object({ query: z.string(), limit: z.number(), offset: z.number() }).nullable(),
      });

      const found = new Set<string>();

      let next: z.infer<typeof searchPage>["next"] = {
        query: "search-pagination-marker",
        limit: 50,
        offset: 0,
      };

      let pages = 0;

      while (next) {
        const pageResult = await rpc("search", next);

        expect(pageResult.isError, pageResult.content[0]?.text).not.toBe(true);
        const page = searchPage.parse(JSON.parse(pageResult.content[0]?.text ?? "null"));

        for (const entry of page.methods) {
          expect(entry.summary).toHaveLength(256);
          found.add(`${entry.hostname}/${entry.entrypoint}`);
        }

        next = page.next;
        expect(++pages).toBeLessThan(10);
      }

      expect(found.size).toBe(12 * 32);
      expect(pages).toBeGreaterThan(1);

      const marker = async () =>
        searchPage.parse(
          JSON.parse(
            (await rpc("search", { query: "search-pagination-marker", limit: 50 })).content[0]
              ?.text ?? "null",
          ),
        );

      const removed = z.string().parse([...found][0]?.split("/")[0]);
      expect((await marker()).remaining).toBe(12 * 32 - 50);

      // A publisher that could not refresh the index must not expose a removed route.
      await request("/unpublish", { hostname: removed, refresh: false });
      const unrefreshed = await marker();
      expect(unrefreshed.methods.map((entry) => entry.hostname)).not.toContain(removed);
      expect(unrefreshed.remaining).toBe(12 * 32 - 50);

      await request("/unpublish", { hostname: removed, refresh: true });
      expect((await marker()).remaining).toBe(11 * 32 - 50);

      // Other services must not push a distinctive match off the first page.
      const inventory = await rpc("search", { query: "inventory" });
      expect(JSON.parse(inventory.content[0]?.text ?? "null")).toMatchObject({
        methods: [{ hostname: service.hostname, entrypoint: service.entrypoint, method: "read" }],
        remaining: 0,
        next: null,
      });

      // A route published and refreshed while the first search scans the routes
      // must survive that search's write.
      await request("/drop-index");
      await request("/publish-during-next-scan", {
        hostname: removed,
        route: {
          organizationId: "widefleet",
          appId: z.string().parse(removed.split(".")[0]),
          access: { revision: 1, groups: [] },
        },
      });
      expect((await marker()).remaining).toBe(11 * 32 - 50);
      expect((await marker()).remaining).toBe(12 * 32 - 50);

      const inventorySearch = async () =>
        z
          .object({
            methods: z.array(z.object({ hostname: z.string() })),
            complete: z.boolean(),
          })
          .parse(
            JSON.parse((await rpc("search", { query: "inventory" })).content[0]?.text ?? "null"),
          );

      // A rebuild reads a bounded number of routes per search. Routes of other
      // organizations sort first, so the first rebuild spans several searches.
      await request("/foreign-routes", { count: 450 });
      await request("/drop-index");
      expect(await inventorySearch()).toEqual({ methods: [], complete: false });
      expect(await inventorySearch()).toEqual({ methods: [], complete: false });

      expect(await inventorySearch()).toEqual({
        methods: [{ hostname: service.hostname }],
        complete: true,
      });

      expect(await (await request("/index")).json()).not.toHaveProperty("scan");

      // A daily rebuild keeps serving the previous index but is not complete
      // until it has read every route.
      await request("/expire-index");
      const rebuilding = { methods: [{ hostname: service.hostname }], complete: false };
      expect(await inventorySearch()).toEqual(rebuilding);
      expect(await inventorySearch()).toEqual(rebuilding);

      expect(await inventorySearch()).toEqual({
        methods: [{ hostname: service.hostname }],
        complete: true,
      });

      const started = Date.now();

      const expired = await rpc("execute", {
        code: "while (true) {}",
      });

      expect(expired.isError, expired.content[0]?.text).toBe(true);
      expect(expired.content[0]?.text).toContain("TimeoutExceeded");
      expect(Date.now() - started).toBeLessThan(40_000);

      const listed = z
        .object({
          result: z.object({
            tools: z.array(
              z.object({
                name: z.string(),
                inputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }),
              }),
            ),
          }),
        })
        .parse(await send("tools/list", {}));

      // send_feedback is the SDK's own tool and takes no analytics arguments.
      for (const tool of listed.result.tools.filter(({ name }) => name !== "send_feedback")) {
        expect(tool.inputSchema.properties).toHaveProperty("context");
        expect(tool.inputSchema.properties).toHaveProperty("conversation_id");
      }

      expect(listed.result.tools.map((tool) => tool.name)).toContain("send_feedback");

      const feedback = await rpc("send_feedback", {
        feedback_type: "missing_capability",
        summary: "No tool to deploy an app.",
      });

      expect(feedback.isError).not.toBe(true);

      const feedbackEvents = () => analytics.filter((event) => event.event === "$mcp_feedback");

      await expect.poll(() => feedbackEvents().length, { timeout: 8_000 }).toBe(1);
      expect(feedbackEvents()[0]).toMatchObject({
        distinct_id: "organization:widefleet",
        properties: { $groups: { organization: "widefleet" } },
      });

      // Each request has its own server, so the conversation ID links calls into one session.
      const first = await rpc("skills", {});

      const { conversation_id: conversationId } = z
        .object({ conversation_id: z.string() })
        .parse(JSON.parse(first.content.at(-1)?.text ?? "null"));

      await rpc("skills", { conversation_id: conversationId });

      const conversation = () =>
        analytics.filter((event) => event.properties["$mcp_conversation_id"] === conversationId);

      await expect.poll(() => conversation().length, { timeout: 8_000 }).toBe(2);
      expect(new Set(conversation().map((event) => event.properties["$session_id"])).size).toBe(1);

      await expect
        .poll(
          () =>
            new Set(
              analytics.flatMap((event) =>
                event.event === "$mcp_tool_call" ? [event.properties["$mcp_tool_name"]] : [],
              ),
            ),
          { timeout: 8_000 },
        )
        .toEqual(
          new Set([
            "skills",
            "cli_login",
            "search",
            "describe",
            "call",
            "ask",
            "answer",
            "execute",
          ]),
        );

      const toolCalls = analytics.filter((event) => event.event.startsWith("$mcp_"));

      for (const event of toolCalls) {
        expect(event).toMatchObject({
          distinct_id: "organization:widefleet",
          properties: {
            $groups: { organization: "widefleet" },
            scope: "fixture",
            service: "app-runtime",
          },
        });
        expect(event.properties).not.toHaveProperty("$mcp_parameters");
        expect(event.properties).not.toHaveProperty("$mcp_response");
      }

      const appCalls = toolCalls.filter(
        (event) =>
          event.properties["$mcp_tool_name"] === "call" ||
          event.properties["$mcp_tool_name"] === "execute",
      );

      // Failed app calls are recorded without their messages, which come from customer apps.
      expect(appCalls.filter((event) => event.properties["$mcp_is_error"] === true)).not.toEqual(
        [],
      );

      for (const event of appCalls)
        expect(event.properties).not.toHaveProperty("$mcp_error_message");

      expect(
        toolCalls.filter(
          (event) =>
            event.properties["$mcp_tool_name"] === "skills" &&
            event.properties["$mcp_error_message"] ===
              'Unknown skill "missing". Available: widefleet',
        ),
      ).toHaveLength(1);

      // A fragment of the code sent to execute, which must not leave the runtime.
      expect(JSON.stringify(toolCalls)).not.toContain("typeof process");
      // App failures behind call and execute are not platform exceptions.
      expect(
        analytics.filter(
          (event) => event.event === "$exception" && "$mcp_tool_name" in event.properties,
        ),
      ).toEqual([]);

      await request("/mcp-revoke", { token: accessToken });
      expect(
        (await request("/mcp", undefined, { authorization: `Bearer ${accessToken}` })).status,
      ).toBe(401);
    }, 60000);

    it("issues app and service tokens with public verification and no control plane, including concurrent cold calls", async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const response = await request("/identity");
          expect(response.status, await response.clone().text()).toBe(200);

          return z
            .object({ own: workloadToken, target: workloadToken, key: z.null() })
            .parse(await response.json());
        }),
      );

      const response = await request("/workload/jwks");
      expect(response.status).toBe(200);

      const published = z
        .object({
          keys: z.array(
            z.strictObject({
              kty: z.literal("RSA"),
              n: z.string(),
              e: z.string(),
              kid: z.string(),
              alg: z.literal("RS256"),
              use: z.literal("sig"),
            }),
          ),
        })
        .parse(await response.json());

      expect(published.keys).toHaveLength(2);
      const keys = createLocalJWKSet(published);
      const issuer = "https://auth.apps.example.test/workload";
      expect(
        await (await request("/workload/.well-known/openid-configuration")).json(),
      ).toMatchObject({
        issuer,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });

      for (const result of results) {
        const own = await jwtVerify(result.own.token, keys, {
          issuer,
          audience: "data-api",
          algorithms: ["RS256"],
        });

        expect(own.payload).toMatchObject({
          app_id: sourceId,
          organization_id: "widefleet",
          aud: "data-api",
          sub: `organization:widefleet:app:${sourceId}`,
          workload_type: "app",
        });
        expect(own.payload.exp! - own.payload.iat!).toBe(300);
        expect(
          (
            await jwtVerify(result.target.token, keys, {
              issuer,
              audience: "other-api",
              algorithms: ["RS256"],
            })
          ).payload,
        ).toMatchObject({ app_id: targetId, organization_id: "widefleet" });
        await expect(
          jwtVerify(result.own.token, keys, { issuer, audience: "wrong-api" }),
        ).rejects.toThrow();
        await expect(
          jwtVerify(result.own.token, keys, {
            issuer: "https://platform.example.test/api/auth",
            audience: "data-api",
          }),
        ).rejects.toThrow();
        await expect(
          jwtVerify(result.own.token, keys, {
            issuer,
            audience: "data-api",
            currentDate: new Date((result.own.expiresAt + 1) * 1000),
          }),
        ).rejects.toThrow();
      }
    });

    it("requires a configured issuer and the published app identity", async () => {
      const identity = {
        appId: sourceId,
        organizationId: "widefleet",
        hostname: `${sourceId}.apps.example.test`,
      };

      expect((await request("/workload-proof", { identity })).status).toBe(200);
      expect((await request("/unconfigured-identity", { identity })).status).toBe(409);

      for (const changes of [
        { appId: targetId },
        { organizationId: "other" },
        { hostname: "unpublished.apps.example.test" },
      ]) {
        expect(
          (await request("/workload-proof", { identity: { ...identity, ...changes } })).status,
        ).toBe(409);
      }

      expect((await request("/workload/jwks?origin=https://unrelated.example.test")).status).toBe(
        404,
      );
    });

    it("admits concurrent cold service calls and streams fetch responses", async () => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const response = await request("/read");

          return { status: response.status, body: await response.text() };
        }),
      );

      for (const response of responses) {
        expect(response.status, response.body).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ version: "v1", secret: "synthetic-one" });
      }

      expect(await (await request("/fetch")).text()).toBe("v1");
      expect((await request("/web")).status).toBe(404);
    });
    it("loads a dropped service Worker again with bindings of the request that calls it", async () => {
      await request("/read");
      await request("/drop-workers", { drop: true });

      try {
        for (const attempt of [1, 2]) {
          const response = await request("/read");
          const body = await response.text();

          expect(response.status, `attempt ${attempt}: ${body}`).toBe(200);
          expect(JSON.parse(body)).toEqual({ version: "v1", secret: "synthetic-one" });
        }
      } finally {
        await request("/drop-workers", { drop: false });
      }
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
    it("gives each app keys it can use but not read", async () => {
      const used = await request("/keys");
      expect(used.status, await used.clone().text()).toBe(200);
      expect(await used.json()).toEqual({
        prefix: "v1.",
        opened: "provider-access",
        verified: true,
        forged: false,
        foreign: "rejected",
      });

      const stored = z
        .array(
          z.strictObject({
            key: z.string(),
            // Sealed with the runtime keyring: a compact JWE with direct encryption.
            value: z.strictObject({
              ciphertext: z
                .string()
                .regex(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
            }),
          }),
        )
        .parse(await (await request("/stored-keys")).json());

      expect(stored.map((entry) => entry.key)).toEqual(
        expect.arrayContaining([
          `app-keys/${sourceId}/tokens.json`,
          `app-keys/${sourceId}/cookies.json`,
        ]),
      );
    });
    it("does not expose provider or platform secrets to the consumer", async () => {
      expect((await request("/secret")).status).toBe(409);
      expect(await (await request("/root")).json()).toBeNull();
      expect(await (await request("/stored")).text()).not.toContain("synthetic-one");
    });
    it("lets a calling app answer a provider's input request with withInput", async () => {
      const asked = await request("/ask");
      const question = await asked.text();
      expect(asked.status, question).toBe(200);
      expect(JSON.parse(question)).toMatchObject({
        resultType: "input_required",
        inputRequests: { confirm: { message: "Send offer-42?" } },
      });
      // The calling app relays the provider's state without reading it.
      expect(question).not.toContain("private-offer-text");

      const answered = await request("/answer");
      expect(answered.status, await answered.clone().text()).toBe(200);
      expect(await answered.json()).toEqual({
        offerId: "offer-42",
        input: {
          inputResponses: { confirm: { action: "accept", content: { note: "ok" } } },
          requestState: { seen: "private-offer-text" },
        },
        caller: null,
      });

      // Answers are delivered only to the call that asked.
      const misdirected = await request("/misdirect");
      expect(misdirected.status).toBe(409);
      expect(await misdirected.text()).toContain("Invalid or expired input request state");
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
    // A control plane that lost its revision counter, for example after a database restore,
    // prepares a used revision again. Its values are current and replace the earlier ones.
    it("replaces the secrets of a revision that is prepared again", async () => {
      await secrets(2, "synthetic-two");
      await publish(targetId, target("v2"), "v2");
      await secrets(2, "synthetic-restored");
      expect(await (await request("/read")).json()).toEqual({
        version: "v2",
        secret: "synthetic-restored",
      });
      expect(await (await request("/stored")).text()).not.toContain("fingerprint");
    });
    it("rewrites stored values sealed before the runtime keyring under its active key version", async () => {
      // A snapshot sealed with the raw bytes of the active version, as earlier runtimes stored it.
      const path = `app-secrets/${targetId}/90.json`;
      const iv = crypto.getRandomValues(new Uint8Array(12));

      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(path) },
          await crypto.subtle.importKey("raw", new Uint8Array(32).fill(0xab), "AES-GCM", false, [
            "encrypt",
          ]),
          new TextEncoder().encode(JSON.stringify({ TOKEN: "synthetic-earlier" })),
        ),
      );

      expect(
        (
          await request("/put-stored", {
            key: path,
            value: JSON.stringify({ ciphertext: btoa(String.fromCharCode(...iv, ...sealed)) }),
          })
        ).status,
      ).toBe(200);

      const pass = () =>
        rekeyRuntime((body) => request("/rekey", runtimeRekeyInput.parse(JSON.parse(body))));

      expect(await pass()).toMatchObject({ rewritten: 1, unreadable: 0, conflicts: 0 });
      expect(await pass()).toMatchObject({ rewritten: 0, unreadable: 0, conflicts: 0 });

      const stored = z.array(z.string()).parse(await (await request("/stored")).json());

      for (const value of stored)
        expect(z.object({ ciphertext: z.string() }).parse(JSON.parse(value)).ciphertext).toContain(
          ".",
        );
    });
    it("blocks cached service invocations while the organization is suspended or unreadable", async () => {
      expect((await request("/read")).status).toBe(200);

      for (const availability of ["blocked", "unavailable"] as const) {
        await request("/availability", { availability });
        expect((await request("/read")).status).toBe(409);
        expect((await request("/fetch")).status).toBe(409);
        expect((await request("/identity")).status).toBe(409);
        expect((await request("/workload/jwks")).status).toBe(200);
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
          // A consuming app cannot present its call as the user's form.
          final: { caller: alice, claimed: null, transported: null, origin: null, site: null },
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
