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
import { createHash } from "node:crypto";
import { build } from "esbuild";
import {
  publishedApp,
  appSecretPreparation,
  appAccessSnapshot,
  serviceDocumentation,
} from "@platform/contracts";
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
  async identity() { return {own: await this.env.WIDEFLEET_IDENTITY.getToken('data-api', {appId: '${targetId}', organizationId: 'forged'}), target: await this.env.TARGET.identity(), key: this.env.WIDEFLEET_CONTROL_TOKEN ?? null}; }
}`;

const target = (version: string) => `import {WorkerEntrypoint} from 'cloudflare:workers';
export class Reader extends WorkerEntrypoint {
  identity() { return this.env.WIDEFLEET_IDENTITY.getToken('other-api'); }
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
        | { identity: { appId: string; organizationId: string; hostname: string } }
        | { availability: "blocked" | "clear" | "unavailable" }
        | { hostname: string; appId: string; access: z.infer<typeof appAccessSnapshot> }
        | { subject: string; groups: string[] }
        | { token: string },
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
      await build({
        entryPoints: [join(root, "packages/app-runtime/fixtures/mcp-oauth.ts")],
        outfile: join(directory, "mcp-fixture.js"),
        bundle: true,
        format: "esm",
        platform: "neutral",
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
${executionRecorder}
export class AppService extends Service { constructor(ctx, env) { super(ctx, recordExecution(env)); } }
export class UnconfiguredIdentity extends Identity { constructor(ctx, env) { super(ctx, {...env,WIDEFLEET_WORKLOAD_ISSUER:undefined}); } }
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  try {
    const fixture = await mcpFixture(request,env,ctx); if(fixture) return fixture;
    if(url.pathname === '/mcp' || url.pathname.startsWith('/oauth/') || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      const loader={get:env.WIDEFLEET_LOADER.get.bind(env.WIDEFLEET_LOADER),load(){throw new Error('MCP must not create a dynamic worker for scripts');}};
      return runtime.fetch(new Request('https://mcp.apps.example.test'+url.pathname,request),{...env,WIDEFLEET_LOADER:loader},ctx);
    }
    if(url.pathname === '/workload-proof' || url.pathname === '/unconfigured-identity') {
      const {identity}=await request.json();
      const binding=url.pathname === '/workload-proof' ? ctx.exports.WorkloadIdentity : ctx.exports.UnconfiguredIdentity;
      return Response.json(await binding({props:identity}).getToken('data-api'));
    }
    if(url.pathname.startsWith('/workload/')) return runtime.fetch(new Request((url.searchParams.get('origin') ?? 'https://auth.apps.example.test')+url.pathname),env,ctx);
    if(url.pathname === '/executions') return Response.json(executions);
    if(url.pathname === '/seed') {
      const {app,source,assets} = await request.json();
      await env.WIDEFLEET_PACKAGES.put('apps/'+app.appId+'/modules/'+app.modules[0].sha256,source);
      for(const [path,content] of Object.entries(assets)) await env.WIDEFLEET_PACKAGES.put('apps/'+app.appId+'/assets/'+app.manifest[path].hash,content);
      if(app.metadata.service_documentation) await env.WIDEFLEET_PACKAGES.put('apps/'+app.appId+'/service-documentation/'+app.id+'.json',JSON.stringify(app.metadata.service_documentation));
      delete app.metadata.service_documentation;
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
            WIDEFLEET_WORKLOAD_ISSUER: "https://auth.apps.example.test/workload",
            WIDEFLEET_MCP_ORIGIN: "https://mcp.apps.example.test",
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
      ["Continue with Google", "https://accounts.google.com"],
      ["Continue with Microsoft", "https://login.microsoftonline.com"],
      ["Continue with Widefleet", "https://platform.example.test"],
      ["Cancel", "https://client.example.test"],
    ])(
      "submits %s in the browser and follows its OAuth redirect",
      async (button, destination) => {
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
              content: z.array(z.object({ text: z.string() })),
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
      expect(initialized.instructions).toMatch(/^To create, change or deploy .*widefleet login/);
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

      const service = {
        hostname: `${targetId}.apps.example.test`,
        entrypoint: "Reader",
        method: "read",
        arguments: [],
      };

      const docs = serviceDocumentation.parse({
        format: 1,
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
                  },
                ],
              },
            ],
          },
        ],
        types: [
          {
            name: "InventoryRecord",
            definition: "{ version: string; secret: string }",
            summary: "A record",
            remarks: "",
            examples: [],
          },
        ],
      });

      const described = async () => {
        const response = await rpc("describe", {
          hostname: service.hostname,
          entrypoint: service.entrypoint,
        });

        expect(response.isError, response.content[0]?.text).not.toBe(true);

        return z.json().parse(JSON.parse(response.content[0]?.text ?? "null"));
      };

      expect(await described()).toMatchObject({ documentation: null, types: [] });

      const documented = await publish(targetId, target("v1"), "v1", {
        metadata: {
          ...snapshot(targetId, target("v1")).metadata,
          service_documentation: docs,
        },
      });

      await setup();
      expect(await described()).toMatchObject({
        documentation: docs.entrypoints[0],
        types: docs.types,
      });
      const search = await rpc("search", { query: "inventory records" });
      expect(JSON.parse(search.content[0]?.text ?? "null")).toMatchObject({
        services: [{ hostname: service.hostname, summary: "Read inventory records" }],
      });

      const denied = await rpc(
        "describe",
        { hostname: service.hostname, entrypoint: service.entrypoint },
        await issue("bob"),
      );

      expect(denied.isError).toBe(true);
      const hidden = await rpc("search", { query: service.hostname }, await issue("bob"));
      expect(JSON.parse(hidden.content[0]?.text ?? "null")).toMatchObject({ services: [] });
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

      await publish(targetId, target("v1"), "v1", {
        metadata: { ...documented.metadata, service_documentation: nextDocs },
      });
      await setup();
      expect(await described()).toMatchObject({ documentation: { summary: "New inventory API" } });
      await request("/seed", { app: documented, source: target("v1"), assets: {} });
      await setup();
      expect(await described()).toMatchObject({
        documentation: docs.entrypoints[0],
        types: docs.types,
      });

      const called = await rpc("call", service);
      expect(called.isError).not.toBe(true);
      expect(JSON.parse(called.content[0]?.text ?? "null")).toMatchObject({ version: "v1" });

      const executed = await rpc("execute", {
        code: `const first = await tools.call(${JSON.stringify(service)}); return {version:first.version, credentials:typeof process};`,
      });

      expect(executed.isError, executed.content[0]?.text).not.toBe(true);
      expect(JSON.parse(executed.content[0]?.text ?? "null")).toEqual({
        version: "v1",
        credentials: "undefined",
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
        format: 1,
        entrypoints: entrypoints.map((name) => ({
          name,
          summary: "x".repeat(7000) + "search-pagination-marker",
          remarks: "",
          examples: [],
          http: false,
          methods: [],
        })),
        types: [],
      });

      for (let index = 0; index < 12; index++) {
        const id = crypto.randomUUID();
        await publish(id, target("v1"), "v1", {
          metadata: {
            ...snapshot(id, target("v1")).metadata,
            entrypoints,
            service_documentation: largeDocs,
          },
        });
      }

      const searchPage = z.object({
        services: z.array(
          z.object({ hostname: z.string(), entrypoint: z.string(), summary: z.string() }),
        ),
        cursor: z.string().nullable(),
      });

      const found = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;

      do {
        const query = "search-pagination-marker";

        const pageResult = await (cursor
          ? rpc("search", { query, cursor })
          : rpc("search", { query }));

        expect(pageResult.isError, pageResult.content[0]?.text).not.toBe(true);
        const page = searchPage.parse(JSON.parse(pageResult.content[0]?.text ?? "null"));

        for (const entry of page.services) {
          expect(entry.summary).toHaveLength(256);
          found.add(`${entry.hostname}/${entry.entrypoint}`);
        }

        cursor = page.cursor;
        expect(++pages).toBeLessThan(10);
      } while (cursor);

      expect(found.size).toBe(12 * 32);
      expect(pages).toBeGreaterThan(1);

      const started = Date.now();

      const expired = await rpc("execute", {
        code: "while (true) {}",
      });

      expect(expired.isError, expired.content[0]?.text).toBe(true);
      expect(expired.content[0]?.text).toContain("TimeoutExceeded");
      expect(Date.now() - started).toBeLessThan(40_000);

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
