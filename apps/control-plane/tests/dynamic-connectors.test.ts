import { connectorFiles, connectorModule } from "./cloudflare-connector.fixture.ts";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  connectorActivation,
  connectorPackage,
  connectorManagement,
  connectorBrowserOrigin,
  publishedApp,
} from "@platform/contracts";
import { encodeConfiguration } from "@platform/auth-proxy/publication";
import { runtimeIdentity } from "./runtime-identity.ts";
import type { TestHarness } from "wrangler";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const hash = (source: string | Uint8Array) => createHash("sha256").update(source).digest("hex");

const token = "dynamic-connector-fixture-control-token-never-deploy";

const organizationId = "widefleet";

const connectorSource = (version: string) => `
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
async function availabilityHold(env, kind) {
  await env.KV.put('availability-started-' + kind, 'yes');
  while (!await env.KV.get('availability-release')) await new Promise(resolve => setTimeout(resolve, 10));
  return kind;
}
export class Counter extends DurableObject {
  constructor(ctx, env) { super(ctx, env); console.info('facet-constructor'); }
  availabilityHold() { return availabilityHold(this.env, 'facet'); }
  waiting;
  releaseWaiter;
  async hold() {
    this.waiting = new Promise(resolve => { this.releaseWaiter = resolve; });
    await this.env.KV.put('holding', 'yes');
    await this.waiting;
    return 'released';
  }
  release() { this.releaseWaiter(); return true; }
  async nested(mode) {
    await this.env.KV.put('nested-started-' + mode, 'yes');
    while (!await this.env.KV.get('nested-release-' + mode)) await new Promise(resolve => setTimeout(resolve, 10));
    const result = await this.env.COUNTER.getByName('nested-' + mode).increment();
    await this.ctx.storage.put('nested-result', result);
    return result;
  }
  nestedBackground() { this.ctx.waitUntil(this.nested('background')); return true; }
  nestedResult() { return this.ctx.storage.get('nested-result'); }
  async increment() {
    console.info('facet-counter', ${JSON.stringify(version)});
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (n INTEGER)');
    this.ctx.storage.sql.exec('INSERT INTO counter VALUES (1)');
    const n = (await this.ctx.storage.get('n') ?? 0) + 1;
    await this.ctx.storage.put('n', n);
    return {n, rows: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM counter').one().n, version: ${JSON.stringify(version)}, secret: await this.env.WIDEFLEET_SECRETS.get('TOKEN')};
  }
  async delayed() {
    await this.env.KV.put('facet-started', 'yes');
    await new Promise(resolve => setTimeout(resolve, 250));
    return this.increment();
  }
  async background() {
    this.ctx.waitUntil((async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
      await this.ctx.storage.put('background', await this.env.WIDEFLEET_SECRETS.get('TOKEN'));
    })());
    return true;
  }
  async backgroundValue() { return await this.ctx.storage.get('background') ?? null; }
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/object-stream') return new Response(url.pathname);
    const mode = url.searchParams.get('mode');
    const env = this.env;
    const ctx = this.ctx;
    let sent = false;
    let cancelled = false;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(${JSON.stringify(version)})); },
      async pull(controller) {
        if (sent) return;
        sent = true;
        while (!cancelled && !await env.KV.get('object-release-' + mode)) await new Promise(resolve => setTimeout(resolve, 10));
        if (cancelled) return;
        if (mode === 'error') { controller.error(new Error('object stream failed')); return; }
        controller.enqueue(new TextEncoder().encode(await env.WIDEFLEET_SECRETS.get('TOKEN')));
        controller.close();
      },
      cancel() {
        cancelled = true;
        const cleanup = (async () => {
          await new Promise(resolve => setTimeout(resolve, 30));
          await ctx.storage.put('cancelled', await env.WIDEFLEET_SECRETS.get('TOKEN'));
        })();
        ctx.waitUntil(cleanup);
        return cleanup;
      },
    }), {headers: {'content-type': 'text/event-stream', 'cache-control': 'no-transform'}});
  }
  cancelled() { return this.ctx.storage.get('cancelled'); }
  async schedule() { await this.ctx.storage.setAlarm(Date.now() + 100); return true; }
  async alarm() { console.info('facet-alarm'); await this.ctx.storage.put('alarm', true); }
  async fired() { return await this.ctx.storage.get('alarm') ?? false; }
}
export class Reader extends WorkerEntrypoint { read() { console.info('named-rpc'); return 'reader'; } fetch(request) { return Response.json({ path: new URL(request.url).pathname, caller: this.ctx.props.caller }); } }
export default class Connector extends WorkerEntrypoint {
  availabilityHold() { return availabilityHold(this.env, 'connector'); }
  caller() { return this.ctx.props.caller; }
  #private = 'private-field';
  own = 'instance-secret';
  echo(value) { return value; }
  async inspect() {
    await this.env.DB.exec('CREATE TABLE IF NOT EXISTS entries (n INTEGER)');
    await this.env.DB.prepare('INSERT INTO entries VALUES (1)').run();
    await this.env.KV.put('value', 'kv');
    await this.env.BUCKET.put('value', 'r2');
    return {version: ${JSON.stringify(version)}, secret: await this.env.WIDEFLEET_SECRETS.get('TOKEN'), private: this.#private,
      parent: this.env.PRIVATE_ROOT_SECRET ?? null, kv: await this.env.KV.get('value'), r2: await (await this.env.BUCKET.get('value')).text()};
  }
  async count() { return this.env.COUNTER.getByName('shared').increment(); }
  async hold() { return this.env.COUNTER.getByName('interleave').hold(); }
  async release() { return this.env.COUNTER.getByName('interleave').release(); }
  nested() { return this.env.COUNTER.getByName('nested-call').nested('call'); }
  nestedBackground() { return this.env.COUNTER.getByName('nested-background').nestedBackground(); }
  nextNested() { return this.env.COUNTER.getByName('nested-call').increment(); }
  nextNestedBackground() { return this.env.COUNTER.getByName('nested-background').increment(); }
  nestedResult() { return this.env.COUNTER.getByName('nested-background').nestedResult(); }
  nextObject(mode) { return this.env.COUNTER.getByName('object-' + mode).increment(); }
  objectCancelled() { return this.env.COUNTER.getByName('object-cancel').cancelled(); }
  async objectError() {
    const response = await this.env.COUNTER.getByName('object-error').fetch('https://object.invalid/object-stream?mode=error');
    const reader = response.body.getReader();
    await reader.read();
    await this.env.KV.put('object-error-started', 'yes');
    try { await reader.read(); return {failed: false}; }
    catch { return {failed: true}; }
  }
  async cancelObject() {
    const response = await this.env.COUNTER.getByName('object-cancel').fetch('https://object.invalid/object-stream?mode=cancel');
    const reader = response.body.getReader();
    await reader.read();
    await this.env.KV.put('object-cancel-started', 'yes');
    while (!await this.env.KV.get('object-cancel-go')) await new Promise(resolve => setTimeout(resolve, 10));
    await reader.cancel();
    return true;
  }
  async stateDelayed() { return this.env.COUNTER.getByName('running').delayed(); }
  async stateNext() { return this.env.COUNTER.getByName('running').increment(); }
  async background() { return this.env.COUNTER.getByName('background').background(); }
  async backgroundValue() { return this.env.COUNTER.getByName('background').backgroundValue(); }
  async objectIds() {
    const id = this.env.COUNTER.idFromName('ä/测试');
    const restored = this.env.COUNTER.idFromString(id.toString());
    const stub = this.env.COUNTER.get(restored);
    const response = await stub.fetch('https://object.invalid/path');
    return [id.equals(restored), stub.id.equals(id), stub.name, await response.text()];
  }
  async schedule() { return this.env.COUNTER.getByName('alarm').schedule(); }
  async fired() { return this.env.COUNTER.getByName('alarm').fired(); }
  async delayed() {
    await this.env.KV.put('started', 'yes');
    await new Promise(resolve => setTimeout(resolve, 300));
    return {version: ${JSON.stringify(version)}, secret: await this.env.WIDEFLEET_SECRETS.get('TOKEN')};
  }
  fail() { throw new Error('connector failure'); }
  fetch(request) {
    console.info('connector-fetch');
    if (new URL(request.url).pathname.endsWith('/browser-caller')) return Response.json({ caller: this.ctx.props.caller, cookie: request.headers.get('cookie'), origin: this.env.WIDEFLEET_ORIGIN }, {headers:{'set-cookie':'connector_test.state=own; Domain=apps.example.test; Path=/; Secure; HttpOnly', 'access-control-allow-origin': '*'}});
    if (new URL(request.url).pathname === '/fetch-failure') throw new Error('connector fetch failure');
    if (new URL(request.url).pathname === '/logging') {
    console.info('connector-request', {version: ${JSON.stringify(version)}});
    console.warn(JSON.stringify({widefleet:1, source:'browser', kind:'log', message:'spoofed-context', buildId:'foreign-build', connectorVersion:'foreign-version', traceId:'a'.repeat(32), spanId:'b'.repeat(16)}));
    console.info(JSON.stringify({widefleet:1, source:'server', message:'invalid-trace-context', traceId:'not-a-trace', spanId:'not-a-span'}));
    this.ctx.waitUntil((async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      console.warn('connector-background');
      throw new Error('background-failure');
    })());
    return Response.json(true);
  }

    if (new URL(request.url).pathname === '/object-stream') {
      const mode = new URL(request.url).searchParams.get('mode');
      return this.env.COUNTER.getByName('object-' + mode).fetch(request);
    }
    if (new URL(request.url).pathname !== '/stream') return new Response('connector:' + new URL(request.url).pathname);
    const env = this.env;
    const ctx = this.ctx;
    let sent = false;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(${JSON.stringify(version)})); },
      async pull(controller) {
        if (sent) return;
        sent = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        controller.enqueue(new TextEncoder().encode(await env.WIDEFLEET_SECRETS.get('TOKEN')));
        controller.close();
      },
      cancel() {
        const cancelled = env.KV.put('stream-cancelled', 'yes');
        ctx.waitUntil(cancelled);
        return cancelled;
      },
    }), {headers: {'content-type': 'text/event-stream', 'cache-control': 'no-transform'}});
  }
}
`;

const release = (version: string, name = "fixture") => {
  const source = connectorSource(version);

  return connectorPackage.parse({
    protocol: 1,
    name,
    modules: [connectorModule("worker.js", "esm", source)],
    metadata: {
      main_module: "worker.js",
      entrypoints: ["default", "Reader"],
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "d1", name: "DB", database_name: "db" },
        { type: "r2_bucket", name: "BUCKET", bucket_name: "bucket" },
        { type: "kv_namespace", name: "KV", id: "kv" },
      ],
      durable_objects: [{ name: "COUNTER", class_name: "Counter" }],
    },
  });
};

const sharedModules = [
  connectorModule("payload.bin", "data", new Uint8Array([0, 255, 128, 1])),
  connectorModule("label.txt", "text", "Grüße"),
  connectorModule(
    "answer.wasm",
    "wasm",
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115,
      119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11,
    ]),
  ),
];

const moduleImports = `import bytes from './payload.bin'; import label from './label.txt'; import wasm from './answer.wasm';`;

const moduleResult = `({bytes: [...new Uint8Array(bytes)], label, answer: new WebAssembly.Instance(wasm).exports.answer()})`;

const applicationSource = (imports: string, result: string) => `${imports}
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/modules') return Response.json(${result});
  const op = new URL(request.url).pathname.slice(1);
  try {
    if (op === 'second') return Response.json(await env.SECOND.inspect());
    if (op === 'secondCount') return Response.json(await env.SECOND.count());
    if (op === 'reader') return Response.json(await env.READER.read());
    if (op === 'logging') return env.CONNECTOR.fetch('https://connector.invalid/logging');
    if (op === 'fetchFailure') return await env.CONNECTOR.fetch('https://connector.invalid/fetch-failure');
    if (op === 'fetch') return env.CONNECTOR.fetch('https://connector.invalid/path');
    if (op === 'stream') return env.CONNECTOR.fetch('https://connector.invalid/stream', {signal: request.signal});
    if (op === 'objectStream') return env.CONNECTOR.fetch('https://connector.invalid/object-stream' + new URL(request.url).search, {signal: request.signal});
    if (op === 'nextObject') return Response.json(await env.CONNECTOR.nextObject(new URL(request.url).searchParams.get('mode')));
    if (op === 'then') return Response.json((await Promise.resolve(env.CONNECTOR)) === env.CONNECTOR);
    if (op === 'values') {
      const result = await env.CONNECTOR.echo({ date: new Date(0), bytes: new Uint8Array([4,2]), map: new Map([['a', 42]]), set: new Set(['b']), big: 42n });
      return Response.json([result.date.getTime(), [...result.bytes], result.map.get('a'), [...result.set], String(result.big)]);
    }
    if (op === 'forbidden') return Response.json(await env.READER.inspect());
    if (op === 'ungranted') return Response.json(env.OTHER ?? null);
    return Response.json(await env.CONNECTOR[op]());
  } catch (error) { return Response.json({error: error.message}, {status: 500}); }
} };`;

describe.runIf(process.env["RUN_CONNECTOR_TESTS"] === "1").each(["celld", "workerd"])(
  "Dynamic connectors on %s",
  (runtime) => {
    const modules =
      runtime === "workerd"
        ? sharedModules
        : sharedModules.filter((module) => module.type === "wasm");

    const imports = runtime === "workerd" ? moduleImports : `import wasm from './answer.wasm';`;

    const result =
      runtime === "workerd"
        ? moduleResult
        : `({answer: new WebAssembly.Instance(wasm).exports.answer()})`;

    const application = applicationSource(imports, result);
    let directory: string;
    let origin: string;
    let identityIssuer: string;
    let native: ReturnType<typeof spawn> | undefined;
    let hosted: TestHarness | undefined;
    let logs = "";
    let initial: z.infer<typeof connectorActivation>;
    let latest: z.infer<typeof connectorActivation>;
    let telemetryUrl: string;

    const telemetryRecords: {
      connector: string;
      record: z.infer<ReturnType<typeof z.json>>;
      traceId: string | undefined;
      spanId: string | undefined;
    }[] = [];

    const collector = createHttpServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];

        for await (const chunk of request)
          chunks.push(Buffer.from(z.instanceof(Uint8Array).parse(chunk)));

        const batch = z
          .object({
            resourceLogs: z.array(
              z.object({
                scopeLogs: z.array(
                  z.object({
                    logRecords: z.array(
                      z.object({
                        body: z.object({ stringValue: z.string() }),
                        traceId: z.string().optional(),
                        spanId: z.string().optional(),
                      }),
                    ),
                  }),
                ),
              }),
            ),
          })
          .parse(JSON.parse(Buffer.concat(chunks).toString()));

        for (const resource of batch.resourceLogs)
          for (const scope of resource.scopeLogs)
            for (const entry of scope.logRecords)
              telemetryRecords.push({
                connector: request.url ?? "",
                record: z.json().parse(JSON.parse(entry.body.stringValue)),
                traceId: entry.traceId,
                spanId: entry.spanId,
              });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      })().catch((cause: unknown) => {
        response.writeHead(500);
        response.end(String(cause));
      });
    });

    const nativeBindings = { DB: "DB", KV: "KV", BUCKET: "BUCKET" };

    const request = (path: string, body?: z.input<typeof connectorManagement>) =>
      (hosted ? hosted.fetch : fetch)(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : null,
        signal: AbortSignal.timeout(4000),
        redirect: "manual",
      }).catch((cause: unknown) => {
        throw new Error(`Request failed: ${path}`, { cause });
      });

    const json = async (path: string, body?: z.input<typeof connectorManagement>) => {
      const response = await request(path, body);
      const text = await response.text();
      expect(response.status, text).toBe(200);

      return z.json().parse(JSON.parse(text));
    };

    const stage = async (candidate: z.infer<typeof connectorPackage>, owner = organizationId) => {
      for (const module of connectorFiles(candidate)) {
        if (module.type === "sourcemap") continue;
        const key = `connectors/${owner}/${candidate.name}/modules/${hash(module.bytes)}`;

        const response = await (hosted ? hosted.fetch : fetch)(
          `${origin}/fixture/module?key=${encodeURIComponent(key)}`,
          { method: "PUT", body: new Uint8Array(module.bytes) },
        );

        expect(response.status).toBe(200);
      }
    };

    const prepare = async (
      version: string,
      secret: string,
      name = "fixture",
      resources = nativeBindings,
      owner = organizationId,
    ) => {
      const candidate = release(version, name);
      await stage(candidate, owner);

      return connectorActivation.parse(
        z.object({ result: connectorActivation }).parse(
          await json("/fixture/manage", {
            action: "prepare",
            organizationId: owner,
            version: crypto.randomUUID(),
            release: candidate,
            nativeBindings: resources,
            browserOrigin: await connectorBrowserOrigin(owner, name, "apps.example.test"),
            secrets: { TOKEN: secret },
            telemetry: { url: `${telemetryUrl}/${name}`, token: "synthetic-connector-telemetry" },
          }),
        ).result,
      );
    };

    const activate = (identity: z.infer<typeof connectorActivation>) =>
      json("/fixture/manage", { action: "activate", ...identity });

    const stop = async () => {
      await hosted?.close();
      hosted = undefined;

      if (native && native.exitCode === null && native.signalCode === null) {
        const exited = once(native, "exit");
        native.kill("SIGTERM");
        const timeout = setTimeout(() => native?.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timeout);
      }
    };

    const start = async () => {
      if (runtime === "workerd") {
        const { createTestHarness } = await import("wrangler");
        hosted = createTestHarness({ workers: [{ configPath: join(directory, "wrangler.json") }] });
        origin = String((await hosted.listen()).url).replace(/\/$/, "");
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
        native.stdout?.on("data", (chunk: Buffer) => {
          logs += chunk.toString();
        });
        native.stderr?.on("data", (chunk: Buffer) => {
          logs += chunk.toString();
        });
        origin = `http://127.0.0.1:${port}`;
        await vi.waitFor(
          async () => {
            if (native?.exitCode !== null) throw new Error(logs);
            expect((await fetch(`${origin}/.well-known/celld/health`)).ok).toBe(true);
          },
          { timeout: 20000 },
        );
      }
    };

    const reload = async () => {
      if (hosted) {
        await hosted.update((current) => current);
      } else {
        await stop();
        await start();
      }
    };

    beforeAll(async () => {
      collector.listen(0, "127.0.0.1");
      await once(collector, "listening");
      telemetryUrl = `http://127.0.0.1:${z.object({ port: z.number() }).parse(collector.address()).port}`;
      directory = await mkdtemp(join(tmpdir(), `dynamic-connectors-${runtime}-`));
      const identity = await runtimeIdentity();
      identityIssuer = z.object({ issuer: z.url() }).parse(identity.configuration.provider).issuer;
      const encrypted = await encodeConfiguration(token, identity.configuration);

      const app = publishedApp.parse({
        id: crypto.randomUUID(),
        appId: crypto.randomUUID(),
        version: crypto.randomUUID(),
        deploymentId: crypto.randomUUID(),
        hostname: "fixture.apps.example.test",
        metadata: {
          main_module: "app.js",
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
        },
        modules: [
          ...modules,
          {
            name: "app.js",
            type: "esm",
            sha256: hash(application),
            size: Buffer.byteLength(application),
          },
        ],
        manifest: {},
        nativeBindings: {},
        capabilities: {
          CONNECTOR: { organizationId, connector: "fixture", entrypoint: "default" },
          READER: { organizationId, connector: "fixture", entrypoint: "Reader" },
          SECOND: { organizationId, connector: "second", entrypoint: "default" },
        },
        network: { revision: 1, policy: { backend: [], browser: [] } },
      });

      await writeFile(
        join(directory, "runtime.js"),
        await readFile(join(root, "packages/app-runtime/dist/loader.js")),
      );
      await writeFile(
        join(directory, "index.js"),
        `
import * as workers from 'cloudflare:workers';
import runtime, {
  ConnectorSupervisor as NativeConnectorSupervisor,
  ConnectorGateway as NativeConnectorGateway,
  ConnectorState as NativeConnectorState,
} from './runtime.js';
export * from './runtime.js';
const availabilityEnvironment = env => ({
  ...env,
  AUTH_CONFIG: {
    async get(key) {
      if (await env.KV.get('availability-read-error')) throw new Error('Synthetic KV read failure');
      return env.AUTH_CONFIG.get(key);
    },
  },
});
export class ConnectorGateway extends NativeConnectorGateway {
  constructor(ctx, env) { super(ctx, availabilityEnvironment(env)); }
}
export class ConnectorState extends NativeConnectorState {
  constructor(ctx, env) { super(ctx, availabilityEnvironment(env)); }
}
export class ConnectorSupervisor extends NativeConnectorSupervisor {
  invoke(identity, method, args) {
    const result = super.invoke(identity, method, args);
    if (method === 'increment') this.ctx.waitUntil(this.env.KV.put('object-received', identity.version));
    return result;
  }
}
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/fixture/app-access') {
    const key = 'apps/fixture.apps.example.test';
    const route = JSON.parse(await env.AUTH_CONFIG.get(key));
    route.access.groups = url.searchParams.has('deny') ? ['denied'] : [];
    await env.AUTH_CONFIG.put(key, JSON.stringify(route));
    return Response.json(true);
  }
  if (url.pathname === '/fixture/app-alias') {
    const app = await (await env.WIDEFLEET_PACKAGES.get('hosts/fixture.apps.example.test.json')).json();
    app.appId = crypto.randomUUID(); app.hostname = 'second-app.apps.example.test';
    await env.WIDEFLEET_PACKAGES.put('hosts/' + app.hostname + '.json', JSON.stringify(app));
    await env.AUTH_CONFIG.put('apps/' + app.hostname, JSON.stringify({organizationId:${JSON.stringify(organizationId)},appId:app.appId,access:{revision:0,groups:[]}}));
    return Response.json(true);
  }
  if (url.pathname === '/fixture/availability') {
    const input = await request.json();
    const key = 'organizations/' + input.organizationId + '/http-availability';
    if (input.value === null) await env.AUTH_CONFIG.delete(key);
    else await env.AUTH_CONFIG.put(key, input.value);
    if (input.readError) await env.KV.put('availability-read-error', 'yes');
    else await env.KV.delete('availability-read-error');
    return Response.json(true);
  }
  if (url.pathname === '/fixture/connector-call') {
    const input = await request.json();
    const gateway = ctx.exports.ConnectorGateway({props: {
      organizationId: input.identity.organizationId, connector: input.identity.name,
      entrypoint: input.entrypoint ?? 'default',
    }});
    const state = ctx.exports.ConnectorState({props: {...input.identity, className: 'Counter'}});
    try {
      if (input.kind === 'fetch') return await gateway.fetch(new Request('https://connector.invalid/path'));
      if (input.kind === 'state-fetch') return await state.fetch(new Request('https://object.invalid/path', {headers: {'x-widefleet-object-id': 'availability-test'}}));
      if (input.kind === 'state-rpc') return Response.json(await state.invoke('availability-test', input.method ?? 'increment', []));
      return Response.json(await gateway.invoke(input.method ?? 'echo', input.args ?? ['available']));
    } catch (error) { return Response.json({error: error.message}, {status: 500}); }
  }
  if (url.pathname === '/fixture/reset-started') {
    await env.KV.delete('availability-started-connector');
    await env.KV.delete('availability-started-facet');
    await env.KV.delete('availability-release');
    return Response.json(true);
  }
  if (url.pathname === '/fixture/release') { await env.KV.put(url.searchParams.get('key'), 'yes'); return Response.json(true); }
  if (url.pathname === '/fixture/manage') return ctx.exports.RuntimeManagement({props:{}}).fetch(new Request('https://runtime.internal/.well-known/widefleet/connectors', request));
  if (url.pathname === '/fixture/started') return Response.json(await env.KV.get(url.searchParams.get('key') ?? 'started'));
  if (url.pathname === '/fixture/seed') {
    const app = ${JSON.stringify(app)};
    await env.WIDEFLEET_PACKAGES.put('apps/' + app.appId + '/modules/${hash(application)}', ${JSON.stringify(application)});
    for (const module of ${JSON.stringify(connectorFiles({ ...release("shared-modules"), modules }).map((file) => ({ sha256: hash(file.bytes), bytes: [...file.bytes] })))}) {
      await env.WIDEFLEET_PACKAGES.put('apps/' + app.appId + '/modules/' + module.sha256, new Uint8Array(module.bytes));
    }
    await env.WIDEFLEET_PACKAGES.put('hosts/' + app.hostname + '.json', JSON.stringify(app));
    await env.AUTH_CONFIG.put('organizations/widefleet/configuration', ${JSON.stringify(encrypted)});
    await env.AUTH_CONFIG.put('apps/' + app.hostname, JSON.stringify({organizationId:"widefleet",appId:app.appId,access:{revision:1,groups:[]}}));
    return Response.json(true);
  }
  if (url.pathname === '/fixture/snapshots') {
    const listing = await env.WIDEFLEET_PACKAGES.list({prefix:'connectors/'});
    const values = [];
    for (const object of listing.objects) {
      if (object.key.includes('/versions/')) values.push(await (await env.WIDEFLEET_PACKAGES.get(object.key)).text());
    }
    return Response.json(values);
  }
  if (url.pathname === '/fixture/modules') {
    const listing = await env.WIDEFLEET_PACKAGES.list({prefix:'connectors/${organizationId}/' + url.searchParams.get('name') + '/modules/'});
    return Response.json(listing.objects.map(object => ({key:object.key, etag:object.etag, uploaded:object.uploaded.toISOString()})));
  }
  if (url.pathname === '/fixture/module') {
    if (request.method === 'PUT') { await env.WIDEFLEET_PACKAGES.put(url.searchParams.get('key'), await request.arrayBuffer(), {onlyIf:{etagDoesNotMatch:'*'}}); return Response.json(true); }
    const input = await request.json();
    if (input.source === null) await env.WIDEFLEET_PACKAGES.delete(input.key);
    else await env.WIDEFLEET_PACKAGES.put(input.key, input.source);
    return Response.json(true);
  }
  if (url.pathname === '/fixture/secret') {
    const identity = await request.json();
    return Response.json(await ctx.exports.ConnectorSecrets({props:identity}).get('TOKEN'));
  }
  url.protocol = 'https:'; url.hostname = request.headers.get('x-fixture-host') ?? 'fixture.apps.example.test'; url.port = '';
  const headers = new Headers(request.headers);
  if (headers.has('x-fixture-signed-out')) headers.delete('cookie');
  else headers.set('cookie', ${JSON.stringify(identity.cookie)} + (headers.get('cookie') ? '; ' + headers.get('cookie') : ''));
  return runtime.fetch(new Request(url, new Request(request, {headers})), env, ctx);
} };`,
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
          name: "connector-runtime-test",
          main: "bundle.js",
          no_bundle: true,
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          vars: {
            WIDEFLEET_CONTROL_TOKEN: token,
            WIDEFLEET_CONNECTOR_KEY: "ab".repeat(32),
            WIDEFLEET_CONFIGURATION: '{"crons":{},"queues":{}}',
            WIDEFLEET_HTTP_AVAILABILITY: "kv",
            PRIVATE_ROOT_SECRET: "parent-only",
          },
          worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
          durable_objects: {
            bindings: [
              { name: "WIDEFLEET_CONNECTORS", class_name: "ConnectorCatalog" },
              { name: "WIDEFLEET_CONNECTOR_STATE", class_name: "ConnectorSupervisor" },
            ],
          },
          migrations: [
            { tag: "v1", new_sqlite_classes: ["ConnectorCatalog", "ConnectorSupervisor"] },
          ],
          d1_databases: [
            { binding: "DB", database_name: "db", database_id: "db" },
            { binding: "SECOND_DB", database_name: "second-db", database_id: "second-db" },
          ],
          kv_namespaces: [
            { binding: "AUTH_CONFIG", id: "auth" },
            { binding: "KV", id: "kv" },
            { binding: "SECOND_KV", id: "second-kv" },
          ],
          r2_buckets: [
            { binding: "WIDEFLEET_PACKAGES", bucket_name: "packages" },
            { binding: "BUCKET", bucket_name: "bucket" },
            { binding: "SECOND_BUCKET", bucket_name: "second-bucket" },
          ],
        }),
      );
      await start();
      await json("/fixture/seed");
    }, 30000);
    afterAll(async () => {
      await stop();
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => (error ? reject(error) : resolve())),
      );

      if (directory) await rm(directory, { recursive: true, force: true });
    });
    it("prepares and activates encrypted code/configuration snapshots", async () => {
      initial = await prepare("v1", "secret-one");
      expect((await request("/inspect")).status).toBe(500);
      await activate(initial);
      expect(await json("/inspect")).toEqual({
        version: "v1",
        secret: "secret-one",
        private: "private-field",
        parent: null,
        kv: "kv",
        r2: "r2",
      });
      expect(JSON.stringify(await json("/fixture/snapshots"))).not.toContain("secret-one");
      expect((await request("/.well-known/widefleet/connectors")).status).toBe(404);
    });
    it("retries legacy snapshots before and after activation without changing their version", async () => {
      const candidate = release("legacy-retry", "legacy-retry");
      const secrets = { TOKEN: "legacy-retry-secret" };

      const input = {
        action: "prepare" as const,
        organizationId,
        version: crypto.randomUUID(),
        release: candidate,
        nativeBindings,
        secrets,
        telemetry: null,
      };

      await stage(candidate);

      const identity = z
        .object({ result: connectorActivation })
        .parse(await json("/fixture/manage", input)).result;

      const snapshots = z
        .array(z.string())
        .parse(await json("/fixture/snapshots"))
        .map((value) => z.record(z.string(), z.json()).parse(JSON.parse(value)));

      const snapshot = z
        .record(z.string(), z.json())
        .parse(snapshots.find((value) => value["version"] === identity.version));

      // Reproduce the persisted format from before connector browser origins existed.
      delete snapshot["browserOrigin"];
      snapshot["fingerprint"] = hash(
        JSON.stringify({ release: candidate, nativeBindings, secrets, telemetry: null }),
      );

      const seeded = await (hosted ? hosted.fetch : fetch)(`${origin}/fixture/module`, {
        method: "POST",
        body: JSON.stringify({
          key: `connectors/${organizationId}/${candidate.name}/versions/${identity.version}.json`,
          source: JSON.stringify(snapshot),
        }),
      });

      expect(seeded.status).toBe(200);
      expect(await json("/fixture/manage", input)).toEqual({ result: identity });
      await activate(identity);
      expect(await json("/fixture/manage", input)).toEqual({ result: identity });
      await activate(identity);
      expect(
        (await request("/fixture/manage", { ...input, secrets: { TOKEN: "changed-secret" } }))
          .status,
      ).toBe(409);
    });
    it("preserves value RPC, named grants, private fields, and fetch", async () => {
      expect(await json("/caller")).toEqual({
        issuer: identityIssuer,
        subject: "pairwise-subject",
        name: "Example User",
      });
      expect(await json("/values")).toEqual([0, [4, 2], 42, ["b"], "42"]);
      expect(await json("/reader")).toBe("reader");
      expect(await json("/then")).toBe(true);
      expect(await json("/objectIds")).toEqual([true, true, "ä/测试", "/path"]);
      expect(await json("/ungranted")).toBeNull();
      expect(await (await request("/fetch")).text()).toBe("connector:/path");

      for (const method of ["own", "constructor", "forbidden", "fail"])
        expect((await request(`/${method}`)).status).toBe(500);
      expect(await json("/count")).toMatchObject({
        n: 1,
        rows: 1,
        version: "v1",
        secret: "secret-one",
      });
    });
    it("isolates browser pages on one stable connector origin shared by app bindings", async () => {
      const path = "/_widefleet/connectors/CONNECTOR/browser-caller";
      expect((await request(path)).status).toBe(302);
      expect((await request("/_widefleet/connectors/UNKNOWN/browser-caller")).status).toBe(404);

      const browserOrigin = await connectorBrowserOrigin(
        organizationId,
        "fixture",
        "apps.example.test",
      );

      const visit = (
        path: string,
        init: { method?: string; headers?: Record<string, string> } = {},
        hostname = new URL(browserOrigin).hostname,
      ) =>
        (hosted ? hosted.fetch : fetch)(`${origin}${path}`, {
          ...init,
          redirect: "manual",
          headers: { ...Object.fromEntries(new Headers(init.headers)), "x-fixture-host": hostname },
        });

      try {
        const redirected = await request(path + "?returnTo=%2Fissues");
        expect(redirected.status).toBe(302);
        expect(redirected.headers.get("location")).toBe(
          `${browserOrigin}/browser-caller?returnTo=%2Fissues`,
        );
        expect(redirected.headers.getSetCookie()).toEqual([]);
        expect(await redirected.text()).toBe("");
        expect((await visit(path, { method: "POST" }, "fixture.apps.example.test")).status).toBe(
          405,
        );

        expect(
          (await visit("/browser-caller", { headers: { "x-fixture-signed-out": "yes" } })).status,
        ).toBe(401);

        const login = await visit("/browser-caller", {
          headers: { "x-fixture-signed-out": "yes", accept: "text/html" },
        });

        expect(login.status).toBe(302);
        const loginUrl = new URL(z.url().parse(login.headers.get("location")));
        expect(loginUrl.hostname).toBe("auth.apps.example.test");
        expect(loginUrl.searchParams.get("rd")).toBe(`${browserOrigin}/browser-caller`);

        const response = await visit("/browser-caller", {
          headers: { cookie: "connector_test.state=own" },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          caller: { issuer: identityIssuer, subject: "pairwise-subject", name: "Example User" },
          cookie: "connector_test.state=own",
          origin: browserOrigin,
        });
        expect(response.headers.getSetCookie()).toEqual([
          "connector_test.state=own; Path=/; Secure; HttpOnly",
        ]);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
        expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");

        const named = await request("/_widefleet/connectors/READER/browser-caller");
        expect(named.headers.get("location")).toBe(`${browserOrigin}/browser-caller`);
        const page = await visit("/_widefleet/entrypoints/Reader/browser-caller");
        expect(page.status).toBe(200);
        expect(await page.json()).toMatchObject({
          origin: browserOrigin,
          caller: { subject: "pairwise-subject" },
        });
        expect((await visit("/_widefleet/entrypoints/Missing/browser-caller")).status).toBe(200);
        const ordinaryPath = "/_widefleet/entrypoints/Reader/custom-route";
        expect(await (await visit(ordinaryPath)).text()).toBe(`connector:${ordinaryPath}`);

        await json("/fixture/app-alias");
        expect(
          (await visit(path, {}, "second-app.apps.example.test")).headers.get("location"),
        ).toBe(`${browserOrigin}/browser-caller`);
        await json("/fixture/app-access?deny");
        expect((await request(path)).status).toBe(403);
        expect((await visit("/browser-caller")).status).toBe(200);
      } finally {
        await json("/fixture/app-access");
        await activate(await prepare("v1", "secret-one"));
      }

      expect((await request(path)).status).toBe(302);
      expect((await visit("/browser-caller")).status).toBe(200);
    });
    it("reuses immutable modules across secret versions and stores only module references", async () => {
      const name = "storage-fixture";
      const first = await prepare("storage-v1", "first-storage-secret", name);
      await activate(first);

      const original = await json(`/fixture/modules?name=${name}`);
      expect(z.array(z.json()).parse(original)).toHaveLength(1);

      const second = await prepare("storage-v1", "second-storage-secret", name);
      await activate(second);
      expect(second.version).not.toBe(first.version);
      expect(await json(`/fixture/modules?name=${name}`)).toEqual(original);

      const snapshots = z
        .array(z.string())
        .parse(await json("/fixture/snapshots"))
        .map((value) =>
          z
            .object({
              version: z.string(),
              release: z.object({ name: z.string(), modules: z.array(z.json()) }),
            })
            .parse(JSON.parse(value)),
        )
        .filter((snapshot) => snapshot.release.name === name);

      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]?.release.modules).toEqual(snapshots[1]?.release.modules);
      expect(snapshots[0]?.release.modules).toEqual([
        {
          name: "worker.js",
          type: "esm",
          sha256: hash(connectorSource("storage-v1")),
          size: Buffer.byteLength(connectorSource("storage-v1")),
        },
      ]);
      await activate(await prepare("storage-v2", "second-storage-secret", name));

      const updated = z.array(z.json()).parse(await json(`/fixture/modules?name=${name}`));

      expect(updated).toHaveLength(2);
      expect(updated).toEqual(expect.arrayContaining(z.array(z.json()).parse(original)));
    });
    it("keeps source maps outside the executable module graph", async () => {
      const candidate = release("mapped", "mapped-fixture");

      const source = JSON.stringify({
        version: 3,
        sources: ["private-connector-source.ts"],
        names: [],
        mappings: "AAAA",
      });

      candidate.metadata.debug = {
        build_id: "mapped-fixture",
        source_maps: { "worker.js": "worker.js.map" },
      };
      candidate.modules.push(connectorModule("worker.js.map", "sourcemap", source));
      await stage(candidate);

      const result = z.object({ result: connectorActivation }).parse(
        await json("/fixture/manage", {
          action: "prepare",
          organizationId,
          version: crypto.randomUUID(),
          release: candidate,
          nativeBindings,
          secrets: {},
          telemetry: null,
        }),
      );

      await activate(result.result);
      expect(
        z.array(z.json()).parse(await json("/fixture/modules?name=mapped-fixture")),
      ).toHaveLength(1);
    });
    it("rejects corrupt or missing modules while secret reads use only the snapshot", async () => {
      const name = "integrity-fixture";
      const first = await prepare("integrity-v1", "integrity-secret", name);
      const source = connectorSource("integrity-v1");
      const key = `connectors/${organizationId}/${name}/modules/${hash(source)}`;

      const overwrite = (source: string | null) =>
        (hosted ? hosted.fetch : fetch)(`${origin}/fixture/module`, {
          method: "POST",
          body: JSON.stringify({ key, source }),
        });

      expect((await overwrite("export default { fetch() {} }; ")).status).toBe(200);

      const input = {
        action: "prepare" as const,
        organizationId,
        version: crypto.randomUUID(),
        release: release("integrity-v1", name),
        nativeBindings,
        secrets: { TOKEN: "integrity-next-secret" },
      };

      const corrupted = await request("/fixture/manage", input);

      expect(corrupted.status).toBe(409);
      expect(await corrupted.json()).toEqual({ error: "Published module checksum mismatch" });
      expect((await overwrite(null)).status).toBe(200);
      // Module integrity is checked on load, outside the WorkerLoader cache.
      await reload();

      const secret = await (hosted ? hosted.fetch : fetch)(`${origin}/fixture/secret`, {
        method: "POST",
        body: JSON.stringify(first),
      });

      expect(await secret.json()).toBe("integrity-secret");

      const missing = await request("/fixture/manage", input);

      expect(missing.status).toBe(409);
      expect(await missing.json()).toEqual({ error: "Published module is missing" });
      expect((await overwrite(source)).status).toBe(200);
      await reload();
      expect((await request("/fixture/manage", input)).status).toBe(200);
    }, 30000);
    it("pins in-flight calls while cached apps and facets switch version", async () => {
      const pending = json("/delayed");
      await vi.waitFor(async () => expect(await json("/fixture/started")).toBe("yes"));
      latest = await prepare("v2", "secret-two");
      await activate(latest);
      expect(await pending).toEqual({ version: "v1", secret: "secret-one" });
      expect(await json("/inspect")).toMatchObject({ version: "v2", secret: "secret-two" });
      expect(await json("/count")).toMatchObject({
        n: 2,
        rows: 2,
        version: "v2",
        secret: "secret-two",
      });
    });
    it("delivers native fetch tails with background logs and the trusted connector version", async () => {
      expect(await json("/logging")).toBe(true);
      expect((await request("/fetchFailure")).status).toBe(500);

      const records = () =>
        telemetryRecords.flatMap((entry) =>
          entry.connector !== "/fixture/v1/logs"
            ? []
            : [
                z
                  .object({
                    message: z.string(),
                    requestId: z.string(),
                    connectorVersion: z.string(),
                    source: z.string(),
                    buildId: z.string().nullable(),
                  })
                  .parse(entry.record),
              ],
        );

      await vi.waitFor(() => {
        const messages = records().map((entry) => entry.message);

        for (const expected of [
          "connector-request",
          "connector-fetch",
          "connector-background",
          "background-failure",
          // celld 0.6.2 does not deliver the failed-fetch or RPC tail on this
          // gateway path. Forward native events without synthesizing them.
          ...(runtime === "workerd" ? ["connector fetch failure", "named-rpc"] : []),
        ])
          expect(
            messages.some((message) => message.includes(expected)),
            `${expected}: ${JSON.stringify(messages)}`,
          ).toBe(true);
      });
      expect(
        records().find((entry) => entry.message.includes("connector-request"))?.connectorVersion,
      ).toBe(latest.version);
      expect(records().find((entry) => entry.message === "spoofed-context")).toMatchObject({
        connectorVersion: latest.version,
        source: "server",
        buildId: null,
      });
      expect(records().find((entry) => entry.message === "connector-background")?.requestId).toBe(
        records().find((entry) => entry.message.includes("connector-request"))?.requestId,
      );

      const context = (message: string) =>
        telemetryRecords.find(
          (entry) => z.object({ message: z.string() }).parse(entry.record).message === message,
        );

      expect(context("spoofed-context")).toMatchObject({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
      });

      for (const message of ["invalid-trace-context", "connector-background"])
        expect(context(message)).toMatchObject({ traceId: undefined, spanId: undefined });
    });
    it("allows calls on one object to interleave without a version switch", async () => {
      const held = json("/hold");
      await vi.waitFor(async () => expect(await json("/fixture/started?key=holding")).toBe("yes"));
      expect(await json("/release")).toBe(true);
      expect(await held).toBe("released");
    });
    it("drains active calls and waitUntil work before rotating a facet", async () => {
      const inFlight = json("/stateDelayed");
      await vi.waitFor(async () =>
        expect(await json("/fixture/started?key=facet-started")).toBe("yes"),
      );
      latest = await prepare("v3", "secret-three");
      await activate(latest);
      const next = json("/stateNext");
      expect(await inFlight).toMatchObject({ version: "v2", secret: "secret-two", n: 1 });
      expect(await next).toMatchObject({ version: "v3", secret: "secret-three", n: 2 });
      expect(await json("/background")).toBe(true);
      latest = await prepare("v3", "secret-four");
      await activate(latest);
      expect(await json("/backgroundValue")).toBe("secret-three");
      expect(await json("/inspect")).toMatchObject({ version: "v3", secret: "secret-four" });
    });
    it("isolates duplicate class names, resources and secrets between connectors", async () => {
      const second = await prepare("other", "other-secret", "second", {
        DB: "SECOND_DB",
        KV: "SECOND_KV",
        BUCKET: "SECOND_BUCKET",
      });

      await activate(second);
      expect(await json("/second")).toMatchObject({ version: "other", secret: "other-secret" });
      expect(await json("/secondCount")).toMatchObject({ n: 1, rows: 1 });
      expect(await json("/inspect")).toMatchObject({ version: "v3", secret: "secret-four" });
    });
    it("streams fetch responses across activation", async () => {
      const response = await fetch(`${origin}/stream`, { signal: AbortSignal.timeout(4000) });
      const reader = response.body?.getReader();

      if (!reader) throw new Error("Connector response has no body");
      expect(
        new TextDecoder().decode(z.instanceof(Uint8Array).parse((await reader.read()).value)),
      ).toBe("v3");
      latest = await prepare("stream-next", "stream-next-secret");
      await activate(latest);
      expect(await json("/inspect")).toMatchObject({ version: "stream-next" });
      expect(
        new TextDecoder().decode(z.instanceof(Uint8Array).parse((await reader.read()).value)),
      ).toBe("secret-four");
      expect((await reader.read()).done).toBe(true);
    });
    // Wrangler's local proxy does not deliver this disconnect to a native Worker
    // either. Exercise upstream cancellation through celld's real HTTP listener.
    it.runIf(runtime === "celld")("forwards stream reader cancellation", async () => {
      const response = await fetch(`${origin}/stream`, { signal: AbortSignal.timeout(4000) });
      const cancelled = response.body?.getReader();

      if (!cancelled) throw new Error("Connector response has no body");
      await cancelled.read();
      await cancelled.cancel();
      await vi.waitFor(async () =>
        expect(await json("/fixture/started?key=stream-cancelled")).toBe("yes"),
      );
    });
    it.each(["call", "background"])(
      "allows nested %s work while its object drains",
      async (mode) => {
        const previous = "nested-old-" + mode;
        await activate(await prepare(previous, previous));
        const pending = json(mode === "call" ? "/nested" : "/nestedBackground");
        const completed = Promise.allSettled([pending]);
        await vi.waitFor(async () =>
          expect(await json("/fixture/started?key=nested-started-" + mode)).toBe("yes"),
        );
        latest = await prepare("nested-new-" + mode, "nested-new-" + mode);
        await activate(latest);
        const next = json(mode === "call" ? "/nextNested" : "/nextNestedBackground");
        const advanced = Promise.allSettled([next]);
        await vi.waitFor(async () =>
          expect(await json("/fixture/started?key=object-received")).toBe(latest.version),
        );
        await json("/fixture/release?key=nested-release-" + mode);
        expect(await completed).toMatchObject([
          { status: "fulfilled", value: mode === "call" ? { version: previous, n: 1 } : true },
        ]);
        expect(await advanced).toMatchObject([
          { status: "fulfilled", value: { version: "nested-new-" + mode, n: 2 } },
        ]);

        if (mode === "background")
          expect(await json("/nestedResult")).toMatchObject({ version: previous, n: 1 });
      },
    );
    it("keeps an object stream alive until completion before replacing its facet", async () => {
      const mode = "complete";
      await activate(await prepare("object-old-" + mode, "object-secret-" + mode));

      const response = await fetch(`${origin}/objectStream?mode=${mode}`, {
        signal: AbortSignal.timeout(4000),
      });

      const reader = response.body?.getReader();

      if (!reader) throw new Error("Object stream has no body");
      expect(
        new TextDecoder().decode(z.instanceof(Uint8Array).parse((await reader.read()).value)),
      ).toBe("object-old-" + mode);

      const rest = (async () => {
        let text = "";

        for (;;) {
          const chunk = await reader.read();

          if (chunk.done) return { text };
          text += new TextDecoder().decode(z.instanceof(Uint8Array).parse(chunk.value));
        }
      })().catch(() => ({ failed: true }));

      latest = await prepare("object-new-" + mode, "object-new-" + mode);
      await activate(latest);
      const next = json("/nextObject?mode=" + mode);
      const advanced = Promise.allSettled([next]);
      await vi.waitFor(async () =>
        expect(await json("/fixture/started?key=object-received")).toBe(latest.version),
      );
      await json("/fixture/release?key=object-release-" + mode);
      expect(await rest).toEqual({ text: "object-secret-" + mode });
      expect(await advanced).toMatchObject([
        { status: "fulfilled", value: { version: "object-new-" + mode, n: 1 } },
      ]);
    });
    it("forwards object stream failures and releases the next generation", async () => {
      await activate(await prepare("error-old", "error-secret"));
      const failed = Promise.allSettled([json("/objectError")]);
      await vi.waitFor(async () =>
        expect(await json("/fixture/started?key=object-error-started")).toBe("yes"),
      );
      latest = await prepare("error-new", "error-new-secret");
      await activate(latest);
      const next = Promise.allSettled([json("/nextObject?mode=error")]);
      await vi.waitFor(async () =>
        expect(await json("/fixture/started?key=object-received")).toBe(latest.version),
      );
      await json("/fixture/release?key=object-release-error");
      expect(await failed).toEqual([{ status: "fulfilled", value: { failed: true } }]);
      expect(await next).toMatchObject([
        { status: "fulfilled", value: { version: "error-new", n: 1 } },
      ]);
    });
    it("waits for object stream cancellation and cleanup before replacing its facet", async () => {
      await activate(await prepare("cancel-old", "cancel-secret"));
      const cancelled = Promise.allSettled([json("/cancelObject")]);
      await vi.waitFor(async () =>
        expect(await json("/fixture/started?key=object-cancel-started")).toBe("yes"),
      );
      latest = await prepare("cancel-new", "new-secret");
      await activate(latest);
      const next = Promise.allSettled([json("/nextObject?mode=cancel")]);
      await vi.waitFor(async () =>
        expect(await json("/fixture/started?key=object-received")).toBe(latest.version),
      );
      await json("/fixture/release?key=object-cancel-go");
      expect(await cancelled).toEqual([{ status: "fulfilled", value: true }]);
      expect(await next).toMatchObject([
        { status: "fulfilled", value: { version: "cancel-new", n: 1 } },
      ]);
      expect(await json("/objectCancelled")).toBe("cancel-secret");
    });
    it("rejects bad code and stale activations, and chooses one concurrent winner", async () => {
      const bad = release("broken");
      bad.modules[0] = connectorModule("worker.js", "esm", "export !!!");
      await stage(bad);
      expect(
        (
          await request("/fixture/manage", {
            action: "prepare",
            organizationId,
            version: crypto.randomUUID(),
            release: bad,
            nativeBindings,
            secrets: {},
          })
        ).status,
      ).toBe(409);
      expect((await request("/fixture/manage", { action: "activate", ...initial })).status).toBe(
        409,
      );
      const first = await prepare("race-a", "secret-a");
      const second = await prepare("race-b", "secret-b");

      const results = await Promise.all(
        [first, second].map((item) => request("/fixture/manage", { action: "activate", ...item })),
      );

      expect(results.map((item) => item.status).sort((a, b) => a - b)).toEqual([200, 409]);
      latest = results[0]?.status === 200 ? first : second;
      await activate(latest);
    });
    it("preserves the native rejection of facet alarms", async () => {
      const response = await request("/schedule");
      expect(response.status).toBe(500);
      expect(await response.text()).toMatch(/alarm/i);
    });

    it("retains facet state across runtime reloads", async () => {
      const before = await json("/inspect");
      await reload();

      expect(await json("/inspect")).toEqual(before);
      expect(await json("/count")).toMatchObject({ n: 3, rows: 3 });
    }, 30000);

    it("preserves default object fetch handlers when installing logging", async () => {
      const source =
        "export default { fetch(request, env, ctx) { console.info('object-handler'); return new Response('object-default'); } };";

      const base = release("object-default");
      base.metadata.entrypoints = ["default"];
      base.metadata.durable_objects = [];
      base.modules = [connectorModule("worker.js", "esm", source)];
      await stage(base);

      const identity = connectorActivation.parse(
        z.object({ result: connectorActivation }).parse(
          await json("/fixture/manage", {
            action: "prepare",
            organizationId,
            version: crypto.randomUUID(),
            nativeBindings,
            secrets: {},
            telemetry: { url: `${telemetryUrl}/fixture`, token: "synthetic-connector-telemetry" },
            release: base,
          }),
        ).result,
      );

      await activate(identity);
      expect(await (await request("/fetch")).text()).toBe("object-default");
      await vi.waitFor(() =>
        expect(
          telemetryRecords.some(
            (entry) =>
              z.object({ message: z.string() }).parse(entry.record).message === "object-handler",
          ),
        ).toBe(true),
      );
      latest = identity;
    });

    it.runIf(runtime === "workerd")(
      "emits hosted connector records through Workers Logs",
      async () => {
        if (!hosted) throw new Error("Missing hosted fixture");
        await hosted.update({
          workers: [
            {
              configPath: join(directory, "wrangler.json"),
              vars: { WIDEFLEET_LOGS: "cloudflare" },
            },
          ],
        });
        hosted.clearLogs();
        expect(await (await request("/fetch")).text()).toBe("object-default");
        await vi.waitFor(() => {
          const record = hosted?.getLogs().find((entry) => entry.message.includes("widefleetLog"));
          expect(record?.message).toContain(latest.version);
          expect(record?.message).toContain(organizationId);
          expect(record?.message).toContain("object-handler");
        });
      },
    );
    it("loads the same native module types for apps and connectors", async () => {
      const expected =
        runtime === "workerd"
          ? { bytes: [0, 255, 128, 1], label: "Grüße", answer: 42 }
          : { answer: 42 };

      expect(await json("/modules")).toEqual(expected);
      const candidate = release("binary-modules");
      candidate.metadata.entrypoints = ["default"];
      candidate.metadata.durable_objects = [];
      candidate.modules = [
        connectorModule(
          "worker.js",
          "esm",
          `${imports} export default {fetch() {return Response.json(${result});}}`,
        ),
        ...modules,
      ];
      await stage(candidate);

      const identity = connectorActivation.parse(
        z.object({ result: connectorActivation }).parse(
          await json("/fixture/manage", {
            action: "prepare",
            organizationId,
            version: crypto.randomUUID(),
            nativeBindings,
            secrets: {},
            release: candidate,
          }),
        ).result,
      );

      await activate(identity);
      expect(await json("/fetch")).toEqual(expected);
    });
    describe("organization suspension", () => {
      let identity: z.infer<typeof connectorActivation>;
      let other: z.infer<typeof connectorActivation>;
      const calls = ["rpc", "fetch", "state-rpc", "state-fetch", "named"] as const;

      const availability = async (value: string | null, readError = false) => {
        const response = await (hosted ? hosted.fetch : fetch)(`${origin}/fixture/availability`, {
          method: "POST",
          body: JSON.stringify({ organizationId, value, readError }),
        });

        expect(response.status).toBe(200);
      };

      const call = (kind: (typeof calls)[number], target = identity, method?: string) =>
        (hosted ? hosted.fetch : fetch)(`${origin}/fixture/connector-call`, {
          method: "POST",
          body: JSON.stringify({
            identity: target,
            kind,
            method: kind === "named" ? "read" : method,
            entrypoint: kind === "named" ? "Reader" : "default",
          }),
        });

      beforeAll(async () => {
        identity = await prepare("availability", "availability-secret", "availability");
        await activate(identity);
        other = await prepare(
          "other-availability",
          "other-secret",
          "availability",
          nativeBindings,
          "22222222-2222-4222-8222-222222222222",
        );
        await activate(other);
      });

      afterEach(async () => {
        await availability(null);
      });

      it("blocks new connector and facet calls, preserves state and resumes after release", async () => {
        expect(await (await call("rpc")).json()).toBe("available");
        expect(await (await call("fetch")).text()).toBe("connector:/path");
        expect(await (await call("named")).json()).toBe("reader");
        expect(await (await call("state-fetch")).text()).toBe("/path");
        expect(await (await call("state-rpc")).json()).toMatchObject({ n: 1, rows: 1 });

        await availability('{"blocked":true}');

        for (const kind of calls) {
          const response = await call(kind);
          expect(response.status).toBe(500);
          expect(await response.text()).toContain("Organization execution is suspended");
        }

        await availability('{"blocked":false}');
        expect(await (await call("state-rpc")).json()).toMatchObject({ n: 2, rows: 2 });

        for (const kind of calls.filter((kind) => kind !== "state-rpc"))
          expect((await call(kind)).status).toBe(200);

        await availability(null);
        expect(await (await call("state-rpc")).json()).toMatchObject({ n: 3, rows: 3 });
      });

      it("keeps same-named connectors in another organization available", async () => {
        await availability('{"blocked":true}');

        for (const kind of calls) {
          expect((await call(kind)).status).toBe(500);
          expect((await call(kind, other)).status).toBe(200);
        }
      });

      it("rejects calls on invalid or failed status reads and recovers", async () => {
        for (const value of ["{", '{"blocked":"yes"}']) {
          await availability(value);

          for (const kind of calls) {
            const response = await call(kind);
            expect(response.status).toBe(500);
            expect(await response.text()).toContain("Organization availability could not be read");
          }
        }

        await availability(null, true);

        for (const kind of calls) {
          const response = await call(kind);
          expect(response.status).toBe(500);
          expect(await response.text()).toContain("Organization availability could not be read");
        }

        await availability('{"blocked":false}');

        for (const kind of calls) expect((await call(kind)).status).toBe(200);
      });

      it("allows already-running connector and facet methods to finish", async () => {
        await json("/fixture/reset-started");
        const connector = call("rpc", identity, "availabilityHold");
        const facet = call("state-rpc", identity, "availabilityHold");

        try {
          await vi.waitFor(async () => {
            expect(await json("/fixture/started?key=availability-started-connector")).toBe("yes");
            expect(await json("/fixture/started?key=availability-started-facet")).toBe("yes");
          });
          await availability('{"blocked":true}');
          expect((await call("rpc")).status).toBe(500);
          expect((await call("state-rpc")).status).toBe(500);
        } finally {
          await json("/fixture/release?key=availability-release");
        }

        expect(await (await connector).json()).toBe("connector");
        expect(await (await facet).json()).toBe("facet");
      });

      it.runIf(runtime === "workerd")(
        "does not read status when the existing gate is disabled",
        async () => {
          if (!hosted) throw new Error("Missing hosted fixture");

          await hosted.update({
            workers: [
              {
                configPath: join(directory, "wrangler.json"),
                vars: { WIDEFLEET_HTTP_AVAILABILITY: "" },
              },
            ],
          });

          try {
            await availability('{"blocked":true}', true);

            for (const kind of calls) expect((await call(kind)).status).toBe(200);
          } finally {
            await availability(null);
            await hosted.update({
              workers: [{ configPath: join(directory, "wrangler.json") }],
            });
          }
        },
      );
    });

    it.runIf(runtime === "celld")(
      "preserves the native rejection of text and data modules",
      async () => {
        for (const module of sharedModules.filter((module) => module.type !== "wasm")) {
          const candidate = release("unsupported-" + module.type, "unsupported-" + module.type);
          candidate.modules.push(module);
          await stage(candidate);

          const response = await request("/fixture/manage", {
            action: "prepare",
            organizationId,
            version: crypto.randomUUID(),
            release: candidate,
            nativeBindings,
            secrets: {},
          });

          expect(response.status).toBe(409);
          expect(await response.text()).toContain("must be a string or wasm bytes");
        }
      },
    );
  },
);
