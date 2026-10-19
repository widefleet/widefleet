import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  connectorActivation,
  connectorPackage,
  connectorManagement,
  publishedApp,
} from "@platform/contracts";
import { encodeConfiguration } from "@platform/auth-proxy/publication";
import { runtimeIdentity } from "./runtime-identity.ts";
import type { TestHarness } from "wrangler";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const hash = (source: string) => createHash("sha256").update(source).digest("hex");

const token = "dynamic-connector-fixture-control-token-never-deploy";

const fleetId = "11111111-1111-4111-8111-111111111111";

const connectorSource = (version: string) => `
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
export class Counter extends DurableObject {
  waiting;
  releaseWaiter;
  async hold() {
    this.waiting = new Promise(resolve => { this.releaseWaiter = resolve; });
    await this.env.KV.put('holding', 'yes');
    await this.waiting;
    return 'released';
  }
  release() { this.releaseWaiter(); return true; }
  async increment() {
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
  fetch(request) { return new Response(new URL(request.url).pathname); }
  async schedule() { await this.ctx.storage.setAlarm(Date.now() + 100); return true; }
  async alarm() { await this.ctx.storage.put('alarm', true); }
  async fired() { return await this.ctx.storage.get('alarm') ?? false; }
}
export class Reader extends WorkerEntrypoint { read() { return 'reader'; } }
export default class Connector extends WorkerEntrypoint {
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
    main: "worker.js",
    modules: [{ name: "worker.js", source, sha256: hash(source) }],
    entrypoints: ["default", "Reader"],
    configuration: {
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      d1_databases: [{ binding: "DB", database_name: "db" }],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "bucket" }],
      kv_namespaces: [{ binding: "KV", id: "kv" }],
      durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
    },
  });
};

const application = `export default { async fetch(request, env) {
  const op = new URL(request.url).pathname.slice(1);
  try {
    if (op === 'second') return Response.json(await env.SECOND.inspect());
    if (op === 'secondCount') return Response.json(await env.SECOND.count());
    if (op === 'reader') return Response.json(await env.READER.read());
    if (op === 'fetch') return env.CONNECTOR.fetch('https://connector.invalid/path');
    if (op === 'stream') return env.CONNECTOR.fetch('https://connector.invalid/stream', {signal: request.signal});
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
    let directory: string;
    let origin: string;
    let native: ReturnType<typeof spawn> | undefined;
    let hosted: TestHarness | undefined;
    let logs = "";
    let initial: z.infer<typeof connectorActivation>;
    let latest: z.infer<typeof connectorActivation>;
    const nativeBindings = { DB: "DB", KV: "KV", BUCKET: "BUCKET" };

    const request = (path: string, body?: z.infer<typeof connectorManagement>) =>
      (hosted ? hosted.fetch : fetch)(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : null,
        signal: AbortSignal.timeout(4000),
      }).catch((cause: unknown) => {
        throw new Error(`Request failed: ${path}`, { cause });
      });

    const json = async (path: string, body?: z.infer<typeof connectorManagement>) => {
      const response = await request(path, body);
      const text = await response.text();
      expect(response.status, text).toBe(200);

      return z.json().parse(JSON.parse(text));
    };

    const prepare = async (
      version: string,
      secret: string,
      name = "fixture",
      resources = nativeBindings,
    ) =>
      connectorActivation.parse(
        z.object({ result: connectorActivation }).parse(
          await json("/fixture/manage", {
            action: "prepare",
            fleetId,
            version: crypto.randomUUID(),
            release: release(version, name),
            nativeBindings: resources,
            secrets: { TOKEN: secret },
          }),
        ).result,
      );

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

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), `dynamic-connectors-${runtime}-`));
      const identity = await runtimeIdentity();
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
          CONNECTOR: { fleetId, connector: "fixture", entrypoint: "default" },
          READER: { fleetId, connector: "fixture", entrypoint: "Reader" },
          SECOND: { fleetId, connector: "second", entrypoint: "default" },
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
import runtime from './runtime.js';
export * from './runtime.js';
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/fixture/manage') return ctx.exports.RuntimeManagement({props:{}}).fetch(new Request('https://runtime.internal/.well-known/widefleet/connectors', request));
  if (url.pathname === '/fixture/started') return Response.json(await env.KV.get(url.searchParams.get('key') ?? 'started'));
  if (url.pathname === '/fixture/seed') {
    const app = ${JSON.stringify(app)};
    await env.WIDEFLEET_PACKAGES.put('apps/' + app.appId + '/modules/${hash(application)}', ${JSON.stringify(application)});
    await env.WIDEFLEET_PACKAGES.put('hosts/' + app.hostname + '.json', JSON.stringify(app));
    await env.AUTH_CONFIG.put('configuration', ${JSON.stringify(encrypted)});
    await env.AUTH_CONFIG.put('apps/' + app.hostname, JSON.stringify({appId:app.appId,access:{revision:1,groups:[]}}));
    return Response.json(true);
  }
  if (url.pathname === '/fixture/snapshots') {
    const listing = await env.WIDEFLEET_PACKAGES.list({prefix:'connectors/'});
    const values = [];
    for (const object of listing.objects) values.push(await (await env.WIDEFLEET_PACKAGES.get(object.key)).text());
    return Response.json(values);
  }
  url.protocol = 'https:'; url.hostname = 'fixture.apps.example.test'; url.port = '';
  const headers = new Headers(request.headers); headers.set('cookie', ${JSON.stringify(identity.cookie)});
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
            WIDEFLEET_CONFIGURATION: '{"crons":{},"queues":{}}',
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
    it("preserves value RPC, named grants, private fields, and fetch", async () => {
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
    it("rejects bad code and stale activations, and chooses one concurrent winner", async () => {
      const bad = release("broken");
      bad.modules[0] = { name: "worker.js", source: "export !!!", sha256: hash("export !!!") };
      expect(
        (
          await request("/fixture/manage", {
            action: "prepare",
            fleetId,
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
    it("routes physical alarms to facets and retains state across runtime reloads", async () => {
      expect(await json("/schedule")).toBe(true);
      await vi.waitFor(async () => expect(await json("/fired")).toBe(true), { timeout: 15000 });
      const before = await json("/inspect");

      if (hosted) {
        await hosted.update((current) => current);
      } else {
        await stop();
        await start();
      }

      expect(await json("/inspect")).toEqual(before);
      expect(await json("/count")).toMatchObject({ n: 3, rows: 3 });
    }, 30000);
  },
);
