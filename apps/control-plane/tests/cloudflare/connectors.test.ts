import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as contract from "@platform/contracts";
import type { Unstable_DevWorker } from "wrangler";
import { createTestEnvironment } from "../environment.ts";
import { connectorFixture } from "../cloudflare-connector.fixture.ts";
import {
  connectorWorkerModules,
  connectorWorkerName,
} from "../../src/lib/server/cloudflare-connector-package.ts";
import { initializeCloudflareFleet } from "../../src/lib/server/fleets.ts";
import { cloudflareOperations, fleets, jobs } from "../../src/lib/server/schema.ts";

const uploadMetadata = z.object({
  annotations: z.object({ "workers/tag": z.string() }),
  bindings: z.array(z.object({ name: z.string(), type: z.string(), text: z.string().optional() })),
  migrations: z.object({ new_tag: z.string(), old_tag: z.string().optional() }).optional(),
});

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")("Hosted connectors in workerd", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let directory: string;
  let worker: Unstable_DevWorker;
  let origin = "";
  let fleetId = "";
  let uploads = 0;
  let mode = "normal";
  let delayedUpload: (() => void) | undefined;
  let localSecret: string | null = "first-synthetic-secret";

  const scripts = new Map<
    string,
    { metadata: z.infer<typeof uploadMetadata>; migration: string | null }
  >();

  const databases = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const buckets = new Set<string>();
  const requests: { path: string; method: string }[] = [];
  const release = connectorFixture();

  const api = createServer((request, response) => {
    const handle = async () => {
      const url = new URL(request.url ?? "/", origin);
      const path = url.pathname;
      requests.push({ path, method: request.method ?? "GET" });
      expect(request.headers.authorization).toBe("Bearer synthetic-connector-token");
      const chunks: Uint8Array[] = [];

      for await (const chunk of request) chunks.push(z.instanceof(Uint8Array).parse(chunk));
      const body = Buffer.concat(chunks);

      const ok = (result: z.infer<typeof uploadMetadata> | z.infer<ReturnType<typeof z.json>>) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ success: true, result }));
      };

      const notFound = () => {
        response.statusCode = 404;
        response.end();
      };

      const json = () => z.record(z.string(), z.string()).parse(JSON.parse(body.toString()));

      if (path.endsWith("/d1/database")) {
        if (request.method === "POST") {
          const name = z.string().parse(json()["name"]);
          expect(databases.has(name)).toBe(false);
          databases.set(name, crypto.randomUUID());
          ok({ name, uuid: databases.get(name) ?? "" });
        } else ok([...databases].map(([name, uuid]) => ({ name, uuid })));
      } else if (path.endsWith("/storage/kv/namespaces")) {
        if (request.method === "POST") {
          const title = z.string().parse(json()["title"]);
          expect(namespaces.has(title)).toBe(false);
          namespaces.set(title, crypto.randomUUID());
          ok({ title, id: namespaces.get(title) ?? "" });
        } else ok([...namespaces].map(([title, id]) => ({ title, id })));
      } else if (path.endsWith("/r2/buckets")) {
        const name = z.string().parse(json()["name"]);
        expect(buckets.has(name)).toBe(false);
        buckets.add(name);
        ok({ name });
      } else if (path.includes("/r2/buckets/")) {
        const name = path.split("/").at(-1) ?? "";

        if (buckets.has(name)) ok({ name });
        else notFound();
      } else if (path.includes("/workers/services/")) {
        const state = scripts.get(path.split("/").at(-1) ?? "");

        if (state) ok({ default_environment: { script: { migration_tag: state.migration } } });
        else notFound();
      } else if (path.endsWith("/settings")) {
        const state = scripts.get(path.split("/").at(-2) ?? "");

        if (state) ok(state.metadata);
        else notFound();
      } else if (path.endsWith("/subdomain")) {
        expect(JSON.parse(body.toString())).toEqual({ enabled: false, previews_enabled: false });
        ok({ enabled: false, previews_enabled: false });
      } else if (path.includes("/workers/scripts/") && request.method === "PUT") {
        const name = path.split("/").at(-1) ?? "";

        const form = await new Response(body, {
          headers: { "content-type": request.headers["content-type"] ?? "" },
        }).formData();

        const metadata = uploadMetadata.parse(JSON.parse(z.string().parse(form.get("metadata"))));
        const source = form.get("connector.js");

        if (!(source instanceof Blob)) throw new Error("Missing uploaded connector source");
        expect(await source.text()).toBe(release.modules[0]?.source);

        const apply = () =>
          scripts.set(name, {
            metadata,
            migration: metadata.migrations?.new_tag ?? scripts.get(name)?.migration ?? null,
          });

        uploads++;
        const selectedMode = mode;
        mode = "normal";

        if (selectedMode === "delayed") delayedUpload = apply;
        else apply();

        if (selectedMode !== "normal") {
          response.statusCode = 503;
          response.end();
        } else ok({ id: name });
      } else throw new Error(`Unexpected fixture endpoint ${path}`);
    };

    void handle().catch((error) => {
      console.error(error);
      response.statusCode = 500;
      response.end();
    });
  });

  const start = async () => {
    const vars = {
      ...environment.environment,
      CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
      CLOUDFLARE_API_TOKEN: "synthetic-connector-token",
      APP_RUNTIME_NAME: "fixture-runtime",
      WIDEFLEET_SECRET_API_KEY: localSecret ?? undefined,
    };

    await writeFile(
      join(directory, "wrangler.json"),
      JSON.stringify({
        name: "connector-test",
        main: "fixture.ts",
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        vars,
        hyperdrive: [
          {
            binding: "HYPERDRIVE",
            id: "0".repeat(32),
            localConnectionString: environment.environment.DATABASE_URL,
          },
        ],
        workflows: [
          {
            binding: "DEPLOYMENTS",
            name: "connector-deployments",
            class_name: "DeploymentWorkflow",
          },
        ],
        r2_buckets: [
          { binding: "ARTIFACTS", bucket_name: "artifacts" },
          { binding: "BUCKET", bucket_name: "files" },
        ],
        d1_databases: [
          {
            binding: "DB",
            database_name: "data",
            database_id: "00000000-0000-4000-8000-000000000001",
          },
        ],
        kv_namespaces: [{ binding: "KV", id: "0".repeat(32) }],
        durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
        services: [
          { binding: "CONNECTOR", service: "connector-test", entrypoint: "WIDEFLEET_CONNECTOR" },
          { binding: "READER", service: "connector-test", entrypoint: "Reader" },
          {
            binding: "WIDEFLEET_SECRETS",
            service: "connector-test",
            entrypoint: "WIDEFLEET_SECRET_READER",
          },
        ],
      }),
    );
    const { unstable_dev } = await import("wrangler");

    return unstable_dev(join(directory, "fixture.ts"), {
      config: join(directory, "wrangler.json"),
      local: true,
      persist: true,
      persistTo: join(directory, "state"),
      ip: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      logLevel: "error",
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });
  };

  const command = async (
    input: { admin?: boolean } & (
      | { kind: "deploy"; release: z.infer<typeof contract.connectorPackage> }
      | { kind: "secret"; name: string; secret: string; value: string | null }
      | { kind: "read"; name: string }
      | { kind: "list" }
    ),
    expected = 200,
  ) => {
    const response = await worker.fetch("http://fixture/command", {
      method: "POST",
      body: JSON.stringify(input),
    });

    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(expected);

    return body;
  };

  const completed = async (id: string, failed = false) => {
    await expect
      .poll(
        async () => {
          const response = await worker.fetch(`http://fixture/status?id=${id}`);
          const state = z.object({ status: z.string() }).parse(await response.json());

          return state.status;
        },
        { timeout: 60_000, interval: 100 },
      )
      .toBe(failed ? "errored" : "complete");

    const [record] = await environment.database.db
      .select()
      .from(cloudflareOperations)
      .where(eq(cloudflareOperations.id, id));

    expect(record?.finishedAt).not.toBeNull();
    expect(Boolean(record?.error)).toBe(failed);
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();
    (await initializeCloudflareFleet(environment.database.db)).unwrap();
    const [fleet] = await environment.database.db.select().from(fleets);

    if (!fleet) throw new Error("Missing fixture fleet");
    fleetId = fleet.id;
    directory = await mkdtemp(join(tmpdir(), "widefleet-connectors-workerd-"));
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(api.address()).port}`;

    for (const module of connectorWorkerModules(release))
      await writeFile(join(directory, module.name), module.source);
    const server = fileURLToPath(new URL("../../src/lib/server/", import.meta.url));
    const workflow = fileURLToPath(new URL("../../src/deployment-workflow.ts", import.meta.url));
    await writeFile(
      join(directory, "fixture.ts"),
      `
      import privateHttp from './__widefleet_connector__.mjs';
      export * from './__widefleet_connector__.mjs';
      export {DeploymentWorkflow} from ${JSON.stringify(workflow)};
      import {withCloudflareDatabase} from ${JSON.stringify(server + "cloudflare-database.ts")};
      import {createCloudflareExecution} from ${JSON.stringify(server + "cloudflare-execution.ts")};
      import {createConnectorService} from ${JSON.stringify(server + "connectors.ts")};
      import {createArtifactStorage} from ${JSON.stringify(server + "artifact-storage.ts")};
      import {createR2Storage} from ${JSON.stringify(server + "storage/r2.ts")};
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {const request = new Request(input, init); const url = new URL(request.url); return nativeFetch(url.origin === 'https://api.cloudflare.com' ? new Request(${JSON.stringify(origin)} + url.pathname + url.search, request) : request);};
      export default {async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/native') {
          try { return Response.json({result: await env.CONNECTOR.inspect(), named: await env.READER.read()}); }
          catch (error) { return Response.json({error: error.message}, {status: 400}); }
        }
        if (url.pathname === '/secret') {
          try { return Response.json(await env.CONNECTOR.secret(url.searchParams.get('name'))); }
          catch (error) { return Response.json({error: error.message}, {status: 400}); }
        }
        if (url.pathname === '/status') return Response.json(await (await env.DEPLOYMENTS.get(url.searchParams.get('id'))).status());
        if (url.pathname === '/command') {
          const input = await request.json();
          const workflow = {get: id => env.DEPLOYMENTS.get(id), async create(options) {
            const modifier = await env.DEPLOYMENTS.unsafeGetInstanceModifier(options.id);
            try {await modifier.disableRetryDelays();} finally {modifier[Symbol.dispose]?.();}
            return env.DEPLOYMENTS.create(options);
          }};
          const result = await withCloudflareDatabase(env, async ({db}) => {
            const storage = createArtifactStorage(createR2Storage(env.ARTIFACTS));
            const execution = createCloudflareExecution({...env, DEPLOYMENTS: workflow}, db, storage);
            const service = createConnectorService(db, storage, env.PLATFORM_ENCRYPTION_KEY, execution);
            const actor = {id: 'fixture-admin', admin: input.admin !== false, creator: true, name: 'Fixture', email: 'fixture@example.test', role: 'admin'};
            if (input.kind === 'deploy') return service.deploy(actor, input.release);
            if (input.kind === 'secret') return service.setSecret(actor, input.name, input.secret, input.value);
            if (input.kind === 'read') return service.read(actor, input.name);
            if (input.kind === 'bind') return service.bind(actor, input.appId, input.binding, input.grant);
            return service.list(actor);
          });
          return Response.json(result.isErr() ? {error: result.error.message} : result.value, {status: result.isErr() ? 400 : 200});
        }
        return privateHttp.fetch(request, env);
      }};
    `,
    );
    worker = await start();
  }, 60_000);
  afterAll(async () => {
    await worker?.stop();
    api.close();
    await environment?.close();

    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("deploys a connector and its resources through native Workflows without agent jobs", async () => {
    const result = contract.connectorStatus.parse(await command({ kind: "deploy", release }));
    await completed(result.jobId);
    expect(uploads).toBe(1);
    expect(databases.size).toBe(1);
    expect(buckets.size).toBe(1);
    expect(namespaces.size).toBe(1);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);

    const current = contract.connectorStatus.parse(
      await command({ kind: "read", name: release.name }),
    );

    expect(current).toMatchObject({ state: "succeeded", appliedChecksum: result.checksum });
    expect(await command({ kind: "deploy", release })).toEqual(current);
  });
  it("rejects unauthorized edits and oversized secrets before accepting an operation", async () => {
    const before = await environment.database.db.select().from(cloudflareOperations);
    await command({ kind: "deploy", release, admin: false }, 400);
    expect(
      await command(
        { kind: "secret", name: release.name, secret: "API_KEY", value: "é".repeat(2501) },
        400,
      ),
    ).toEqual({ error: "Hosted connector secrets must contain at most 5 KB (5000 UTF-8 bytes)" });
    expect(await environment.database.db.select().from(cloudflareOperations)).toHaveLength(
      before.length,
    );
  });
  it("rotates and removes native secrets without retaining plaintext in history", async () => {
    for (const secret of ["first-synthetic-secret", "second-synthetic-secret", null]) {
      const result = contract.connectorStatus.parse(
        await command({ kind: "secret", name: release.name, secret: "API_KEY", value: secret }),
      );

      await completed(result.jobId);
      const uploaded = scripts.get(connectorWorkerName(fleetId, release.name));
      expect(
        uploaded?.metadata.bindings.find((binding) => binding.type === "secret_text")?.text ?? null,
      ).toBe(secret);

      const history = JSON.stringify(
        await environment.database.db.select().from(cloudflareOperations),
      );

      if (secret !== null) expect(history).not.toContain(secret);
      expect(databases.size).toBe(1);
      expect(buckets.size).toBe(1);
      expect(namespaces.size).toBe(1);
    }
  });
  it("confirms a lost upload response without uploading twice", async () => {
    const before = uploads;
    mode = "lost-response";

    const result = contract.connectorStatus.parse(
      await command({
        kind: "secret",
        name: release.name,
        secret: "API_KEY",
        value: "confirmed-synthetic-secret",
      }),
    );

    await completed(result.jobId);
    expect(uploads).toBe(before + 1);
  });
  it("does not reserve an upload when migration preparation fails", async () => {
    const script = scripts.get(connectorWorkerName(fleetId, release.name));

    if (!script) throw new Error("Missing deployed connector");
    const previous = script.migration;
    const before = uploads;
    script.migration = "unknown-remote-tag";

    const failed = contract.connectorStatus.parse(
      await command({
        kind: "secret",
        name: release.name,
        secret: "API_KEY",
        value: "prepared-secret",
      }),
    );

    await completed(failed.jobId, true);
    expect(uploads).toBe(before);
    script.migration = previous;
    const retried = contract.connectorStatus.parse(await command({ kind: "deploy", release }));
    await completed(retried.jobId);
    expect(uploads).toBe(before + 1);
  });

  it("blocks newer uploads until a delayed write is confirmed", async () => {
    const before = uploads;
    mode = "delayed";

    const first = contract.connectorStatus.parse(
      await command({
        kind: "secret",
        name: release.name,
        secret: "API_KEY",
        value: "delayed-synthetic-secret",
      }),
    );

    await completed(first.jobId, true);

    const pending = contract.connectorStatus.parse(
      await command({ kind: "read", name: release.name }),
    );

    expect(pending.state).toBe("failed");
    expect(pending.message).toContain("unconfirmed");

    const second = contract.connectorStatus.parse(
      await command({
        kind: "secret",
        name: release.name,
        secret: "API_KEY",
        value: "later-synthetic-secret",
      }),
    );

    await completed(second.jobId, true);
    expect(uploads).toBe(before + 1);
    delayedUpload?.();
    delayedUpload = undefined;
    const recovery = contract.connectorStatus.parse(await command({ kind: "deploy", release }));
    await completed(recovery.jobId);
    expect(uploads).toBe(before + 2);
    expect(
      scripts.get(connectorWorkerName(fleetId, release.name))?.metadata.bindings,
    ).toContainEqual({
      type: "secret_text",
      name: "WIDEFLEET_SECRET_API_KEY",
      text: "later-synthetic-secret",
    });
  });
  it("isolates connector resources and secrets while allowing the same Durable Object class names", async () => {
    const second = connectorFixture("second-connector");

    const initial = contract.connectorStatus.parse(
      await command({ kind: "deploy", release: second }),
    );

    await completed(initial.jobId);

    const secret = contract.connectorStatus.parse(
      await command({
        kind: "secret",
        name: second.name,
        secret: "API_KEY",
        value: "second-connector-secret",
      }),
    );

    await completed(secret.jobId);
    expect(databases.size).toBe(2);
    expect(buckets.size).toBe(2);
    expect(namespaces.size).toBe(2);

    const firstBindings = scripts.get(connectorWorkerName(fleetId, release.name))?.metadata
      .bindings;

    const secondBindings = scripts.get(connectorWorkerName(fleetId, second.name))?.metadata
      .bindings;

    expect(firstBindings?.find((binding) => binding.type === "secret_text")?.text).toBe(
      "later-synthetic-secret",
    );
    expect(secondBindings?.find((binding) => binding.type === "secret_text")?.text).toBe(
      "second-connector-secret",
    );
  });

  it("executes original RPC classes with private fields and persistent D1, R2, KV and Durable Objects", async () => {
    expect((await worker.fetch("http://fixture/public")).status).toBe(404);
    const first = await worker.fetch("http://fixture/native");
    expect(await first.json()).toEqual({
      named: "private-field",
      result: { secret: localSecret, count: 1, kv: "connector", bucket: "connector", counter: 1 },
    });
    await worker.stop();
    localSecret = "rotated-native-secret";
    worker = await start();
    const second = await worker.fetch("http://fixture/native");
    expect(await second.json()).toEqual({
      named: "private-field",
      result: { secret: localSecret, count: 2, kv: "connector", bucket: "connector", counter: 2 },
    });

    for (const name of ["MISSING", "LABEL", "WIDEFLEET_SECRET_API_KEY", "__proto__"])
      expect((await worker.fetch(`http://fixture/secret?name=${name}`)).status).toBe(400);
    await worker.stop();
    localSecret = null;
    worker = await start();
    expect((await worker.fetch("http://fixture/secret?name=API_KEY")).status).toBe(400);
  }, 60_000);
});
