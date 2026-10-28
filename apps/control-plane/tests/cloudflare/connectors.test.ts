import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { connectorCommand } from "../../src/lib/server/cloudflare-connector-command.ts";
import { organization } from "../../src/lib/server/auth-schema.ts";
import { z } from "zod";
import * as contract from "@platform/contracts";
import type { Unstable_DevWorker } from "wrangler";
import { createTestEnvironment } from "../environment.ts";
import { connectorFixture, connectorFiles } from "../cloudflare-connector.fixture.ts";
import runtimeRelease from "@platform/app-runtime/release" with { type: "json" };
import { cloudflareResourceName } from "../../src/lib/server/cloudflare-provisioning.ts";
import { initializeCloudflareRuntime } from "../../src/lib/server/organization-runtime.ts";
import { cloudflareOperations, organizationRuntimes, jobs } from "../../src/lib/server/schema.ts";

const runtimeSettings = z.object({
  annotations: z.object({ "workers/tag": z.string() }).optional(),
  bindings: z.array(z.record(z.string(), z.json())),
});

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")("Hosted connectors in workerd", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let directory: string;
  let worker: Unstable_DevWorker;
  let origin = "";
  let organizationId = "";
  let patches = 0;
  let settings: z.infer<typeof runtimeSettings> = { bindings: [] };
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

      const ok = (result: z.infer<typeof runtimeSettings> | z.infer<ReturnType<typeof z.json>>) => {
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
        } else
          ok(
            [...databases]
              .map(([name, uuid]) => ({ name, uuid }))
              .slice(
                (Number(url.searchParams.get("page") ?? 1) - 1) * 100,
                Number(url.searchParams.get("page") ?? 1) * 100,
              ),
          );
      } else if (path.endsWith("/storage/kv/namespaces")) {
        if (request.method === "POST") {
          const title = z.string().parse(json()["title"]);
          expect(namespaces.has(title)).toBe(false);
          namespaces.set(title, crypto.randomUUID());
          ok({ title, id: namespaces.get(title) ?? "" });
        } else
          ok(
            [...namespaces]
              .map(([title, id]) => ({ title, id }))
              .slice(
                (Number(url.searchParams.get("page") ?? 1) - 1) * 100,
                Number(url.searchParams.get("page") ?? 1) * 100,
              ),
          );
      } else if (path.endsWith("/r2/buckets")) {
        const name = z.string().parse(json()["name"]);
        expect(buckets.has(name)).toBe(false);
        buckets.add(name);
        ok({ name });
      } else if (path.includes("/r2/buckets/")) {
        const name = path.split("/").at(-1) ?? "";

        if (buckets.has(name)) ok({ name });
        else notFound();
      } else if (path.endsWith("/workers/scripts/fixture-runtime/settings")) {
        if (request.method === "PATCH") {
          const form = await new Response(body, {
            headers: { "content-type": request.headers["content-type"] ?? "" },
          }).formData();

          const next = runtimeSettings.parse(JSON.parse(z.string().parse(form.get("settings"))));
          next.bindings = next.bindings.map((binding) =>
            binding["type"] === "inherit"
              ? (settings.bindings.find((previous) => previous["name"] === binding["name"]) ??
                binding)
              : binding,
          );
          settings = next;
          patches++;
        }

        ok(settings);
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
      WIDEFLEET_CONTROL_TOKEN: "hosted-connector-control-key-never-deploy",
      WIDEFLEET_CONNECTOR_KEY: "ab".repeat(32),
      WIDEFLEET_CONFIGURATION: '{"crons":{},"queues":{}}',
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
        worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
        r2_buckets: [
          { binding: "ARTIFACTS", bucket_name: "artifacts" },
          { binding: "WIDEFLEET_PACKAGES", bucket_name: "artifacts" },
          ...[release.name, "second-connector"].map((name) => ({
            binding: `B_${cloudflareResourceName(`${organizationId}/connector/${name}`, "r2", "files")}`,
            bucket_name: `files-${name}`,
          })),
        ],
        d1_databases: [release.name, "second-connector"].map((name) => ({
          binding: `B_${cloudflareResourceName(`${organizationId}/connector/${name}`, "d1", "data")}`,
          database_name: `data-${name}`,
          database_id: name,
        })),
        kv_namespaces: [
          { binding: "TEST_CONTROL", id: "test-control" },
          ...[release.name, "second-connector"].map((name) => ({
            binding: `B_${cloudflareResourceName(`${organizationId}/connector/${name}`, "kv", "cache")}`,
            id: name,
          })),
        ],
        durable_objects: {
          bindings: [
            { name: "WIDEFLEET_CONNECTORS", class_name: "ConnectorCatalog" },
            { name: "WIDEFLEET_CONNECTOR_STATE", class_name: "ConnectorSupervisor" },
          ],
        },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["ConnectorCatalog", "ConnectorSupervisor"] },
        ],
        services: [
          { binding: "APP_RUNTIME", service: "connector-test", entrypoint: "RuntimeManagement" },
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
    input: {
      admin?: boolean;
      requestId?: string;
      application?: z.infer<typeof contract.applicationContext>;
    } & (
      | { kind: "deploy"; release: z.infer<typeof contract.connectorPackage> }
      | { kind: "secret"; name: string; secret: string; value: string | null }
      | { kind: "read"; name: string }
      | { kind: "list" }
    ),
    expected = 200,
  ) => {
    const response = await worker.fetch("http://fixture/command", {
      method: "POST",
      body: JSON.stringify(
        input.kind === "deploy"
          ? {
              ...input,
              requestId: input.requestId ?? crypto.randomUUID(),
              modules: connectorFiles(input.release).map((module) => ({
                ...module,
                bytes: [...module.bytes],
              })),
            }
          : input,
      ),
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
    (await initializeCloudflareRuntime(environment.database.db)).unwrap();
    const [execution] = await environment.database.db.select().from(organizationRuntimes);

    if (!execution) throw new Error("Missing fixture execution");
    organizationId = execution.organizationId;
    directory = await mkdtemp(join(tmpdir(), "widefleet-connectors-workerd-"));
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(api.address()).port}`;

    for (const module of runtimeRelease.modules)
      await writeFile(join(directory, module.name), module.source);
    const server = fileURLToPath(new URL("../../src/lib/server/", import.meta.url));
    const workflow = fileURLToPath(new URL("../../src/deployment-workflow.ts", import.meta.url));
    await writeFile(
      join(directory, "fixture.ts"),
      `
      import { RuntimeManagement as BaseManagement } from './loader.js';
      export * from './loader.js';
      export class RuntimeManagement extends BaseManagement {
        async fetch(request) {
          const input = await request.clone().json();
          const response = await super.fetch(request);
          if (input.action === 'activate' && response.ok && await this.env.TEST_CONTROL.get('lose-response')) {
            await this.env.TEST_CONTROL.delete('lose-response');
            throw new Error('Synthetic lost activation response');
          }
          return response;
        }
      }
      export {DeploymentWorkflow} from ${JSON.stringify(workflow)};
      import {createCloudflareConnectorDeployment} from ${JSON.stringify(server + "cloudflare-connector-deployment.ts")};
      import {withCloudflareDatabase} from ${JSON.stringify(server + "cloudflare-database.ts")};
      import {createCloudflareExecution} from ${JSON.stringify(server + "cloudflare-execution.ts")};
      import {createConnectorService} from ${JSON.stringify(server + "connectors.ts")};
      import {createArtifactStorage} from ${JSON.stringify(server + "artifact-storage.ts")};
      import {createR2Storage} from ${JSON.stringify(server + "storage/r2.ts")};
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {const request = new Request(input, init); const url = new URL(request.url); return nativeFetch(url.origin === 'https://api.cloudflare.com' ? new Request(${JSON.stringify(origin)} + url.pathname + url.search, request) : request);};
      export default {async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const name = url.searchParams.get('connector') ?? ${JSON.stringify(release.name)};
        const props = {organizationId: url.searchParams.get('execution') ?? ${JSON.stringify(organizationId)}, connector:name, entrypoint:'default'};
        const gateway = () => ctx.exports.ConnectorGateway({props});
        if (url.pathname === '/fault') { await env.TEST_CONTROL.put('lose-response', 'yes'); return Response.json(true); }
        if (url.pathname === '/active') return Response.json(await env.WIDEFLEET_CONNECTORS.get(env.WIDEFLEET_CONNECTORS.idFromName(JSON.stringify([props.organizationId, name]))).current());
        if (url.pathname === '/native') {
          try { return Response.json({result: await gateway().invoke('inspect', []), named: await ctx.exports.ConnectorGateway({props:{...props,entrypoint:'Reader'}}).invoke('read', [])}); }
          catch (error) { return Response.json({error: error.message}, {status: 400}); }
        }
        if (url.pathname === '/secret') {
          try { return Response.json(await gateway().invoke('secret', [url.searchParams.get('name')])); }
          catch (error) { return Response.json({error: error.message}, {status: 400}); }
        }
        if (url.pathname === '/status') return Response.json(await (await env.DEPLOYMENTS.get(url.searchParams.get('id'))).status());
        if (url.pathname === '/replay') {
          const input = await request.json();
          const runner = createCloudflareConnectorDeployment(env);
          try {
            if (input.action === 'provision') await runner.provision(input.command);
            else if (input.action === 'activate') await runner.activate(input.command, {});
            else await runner.fail(input.command, 'Synthetic failure');
            return Response.json(true);
          } catch (error) { return Response.json({error: error.message}, {status:400}); }
        }
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
            const actor = {id: 'fixture-admin', admin: input.application ? false : input.admin !== false, creator: true, name: 'Fixture', email: 'fixture@example.test', role: 'admin', application: input.application ?? {...${JSON.stringify(environment.application)}, admin:input.admin !== false}};
            if (input.kind === 'deploy') return service.deploy(actor, input.release, input.modules.map(module => ({...module, bytes: new Uint8Array(module.bytes)})), input.requestId);
            if (input.kind === 'secret') return service.setSecret(actor, input.name, input.secret, input.value);
            if (input.kind === 'read') return service.read(actor, input.name);
            if (input.kind === 'bind') return service.bind(actor, input.appId, input.binding, input.grant);
            return service.list(actor);
          });
          return Response.json(result.isErr() ? {error: result.error.message} : result.value, {status: result.isErr() ? 400 : 200});
        }
        return new Response(null, {status:404});
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

  it("deploys through Workflows using shared runtime resources and no connector Worker", async () => {
    const requestId = crypto.randomUUID();

    const result = contract.connectorStatus.parse(
      await command({ kind: "deploy", release, requestId }),
    );

    await completed(result.jobId);
    expect(patches).toBe(1);
    expect(databases.size).toBe(1);
    expect(buckets.size).toBe(1);
    expect(namespaces.size).toBe(1);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    expect(
      requests.some(
        (request) => request.method === "PUT" && request.path.includes("/workers/scripts/"),
      ),
    ).toBe(false);

    const current = contract.connectorStatus.parse(
      await command({ kind: "read", name: release.name }),
    );

    expect(current).toMatchObject({ state: "succeeded", appliedChecksum: result.checksum });
    expect(await command({ kind: "deploy", release, requestId })).toEqual(current);
  }, 60_000);
  it("rejects unauthorized edits and oversized secrets before accepting operations", async () => {
    const before = await environment.database.db.select().from(cloudflareOperations);
    await command({ kind: "deploy", release, admin: false }, 400);
    await command(
      { kind: "secret", name: release.name, secret: "API_KEY", value: "é".repeat(2501) },
      400,
    );
    expect(await environment.database.db.select().from(cloudflareOperations)).toHaveLength(
      before.length,
    );
  });
  it("rotates and removes secrets without native deployments or plaintext history", async () => {
    const before = patches;

    for (const secret of ["é".repeat(2500), "second-synthetic-secret", null]) {
      const result = contract.connectorStatus.parse(
        await command({ kind: "secret", name: release.name, secret: "API_KEY", value: secret }),
      );

      await completed(result.jobId);
      const response = await worker.fetch("http://fixture/secret?name=API_KEY");
      expect(response.status).toBe(secret === null ? 400 : 200);

      if (secret !== null) {
        expect(await response.json()).toBe(secret);
        expect(
          JSON.stringify(await environment.database.db.select().from(cloudflareOperations)),
        ).not.toContain(secret);
      }
    }

    expect(patches).toBe(before);
  }, 60_000);
  it("reconciles a lost activation response without activating a second generation", async () => {
    const previous = z
      .object({ sequence: z.number() })
      .parse(await (await worker.fetch("http://fixture/active")).json());

    await worker.fetch("http://fixture/fault");

    const accepted = contract.connectorStatus.parse(
      await command({
        kind: "secret",
        name: release.name,
        secret: "API_KEY",
        value: "recovered-secret",
      }),
    );

    await completed(accepted.jobId);
    expect(await (await worker.fetch("http://fixture/active")).json()).toMatchObject({
      sequence: previous.sequence + 1,
    });
    expect(await (await worker.fetch("http://fixture/secret?name=API_KEY")).json()).toBe(
      "recovered-secret",
    );
  }, 60_000);
  it("isolates matching class names and resources across connectors", async () => {
    const second = connectorFixture("second-connector");

    const deployed = contract.connectorStatus.parse(
      await command({ kind: "deploy", release: second }),
    );

    await completed(deployed.jobId);

    const secret = contract.connectorStatus.parse(
      await command({
        kind: "secret",
        name: second.name,
        secret: "API_KEY",
        value: "second-secret",
      }),
    );

    await completed(secret.jobId);

    for (const [name, value] of [
      [release.name, "recovered-secret"],
      [second.name, "second-secret"],
    ]) {
      expect(await (await worker.fetch("http://fixture/native?connector=" + name)).json()).toEqual({
        named: "private-field",
        result: { secret: value, count: 1, kv: "connector", bucket: "connector", counter: 1 },
      });
    }

    expect(await (await worker.fetch("http://fixture/native")).json()).toMatchObject({
      result: { counter: 2, count: 2 },
    });

    for (const name of ["MISSING", "LABEL", "WIDEFLEET_SECRET_API_KEY", "__proto__"])
      expect((await worker.fetch("http://fixture/secret?name=" + name)).status).toBe(400);
  }, 60_000);
  it("preserves concurrent secret edits and distinct accepted operations", async () => {
    const accepted = (
      await Promise.all(
        ["ALPHA", "BETA"].map((secret) =>
          command({ kind: "secret", name: release.name, secret, value: "synthetic-" + secret }),
        ),
      )
    ).map((value) => contract.connectorStatus.parse(value));

    expect(new Set(accepted.map((item) => item.jobId)).size).toBe(2);

    const current = contract.connectorStatus.parse(
      await command({ kind: "read", name: release.name }),
    );

    await completed(current.jobId);

    for (const name of ["ALPHA", "BETA"])
      expect(await (await worker.fetch("http://fixture/secret?name=" + name)).json()).toBe(
        "synthetic-" + name,
      );
  }, 60_000);
  it("enforces shared variable limits across deployments and secret updates", async () => {
    const vars = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`VAR_${i}`, ""]));
    vars["VAR_0"] = "é".repeat(2500);

    const initial = contract.connectorPackage.parse({
      ...connectorFixture("environment-limits"),
      metadata: {
        main_module: "connector.js",
        entrypoints: ["default"],
        compatibility_date: "2026-10-01",
        bindings: Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text })),
      },
    });

    const before = await environment.database.db.select().from(cloudflareOperations);

    for (const value of ["x".repeat(16_385), "é".repeat(16_385)])
      expect(
        await command(
          {
            kind: "deploy",
            release: {
              ...initial,
              metadata: {
                ...initial.metadata,
                bindings: [{ type: "plain_text", name: "LABEL", text: value }],
              },
            },
          },
          400,
        ),
      ).toHaveProperty("error");
    await command(
      {
        kind: "deploy",
        release: {
          ...initial,
          metadata: {
            ...initial.metadata,
            bindings: [
              ...initial.metadata.bindings,
              { type: "plain_text", name: "EXTRA", text: "" },
              { type: "plain_text", name: "OVERFLOW", text: "" },
            ],
          },
        },
      },
      400,
    );
    expect(await environment.database.db.select().from(cloudflareOperations)).toHaveLength(
      before.length,
    );

    const deployed = contract.connectorStatus.parse(
      await command({ kind: "deploy", release: initial }),
    );

    await completed(deployed.jobId);

    for (const value of ["synthetic", "rotated"]) {
      const secret = contract.connectorStatus.parse(
        await command({
          kind: "secret",
          name: initial.name,
          secret: "API_KEY",
          value,
        }),
      );

      await completed(secret.jobId);
    }

    const maximum = {
      ...initial,
      metadata: {
        ...initial.metadata,
        bindings: [
          ...initial.metadata.bindings,
          { type: "plain_text" as const, name: "EXTRA", text: "x".repeat(16_384) },
        ],
      },
    };

    const next = contract.connectorStatus.parse(
      await command({ kind: "deploy", release: maximum }),
    );

    await completed(next.jobId);

    const deleted = contract.connectorStatus.parse(
      await command({ kind: "secret", name: initial.name, secret: "API_KEY", value: null }),
    );

    await completed(deleted.jobId);
  }, 60_000);
  it("replays upload identities without replacing a newer deployment", async () => {
    const initial = release;
    const requestId = crypto.randomUUID();

    const first = contract.connectorStatus.parse(
      await command({ kind: "deploy", release: initial, requestId }),
    );

    await completed(first.jobId);

    const second = contract.connectorStatus.parse(
      await command({ kind: "deploy", release: initial }),
    );

    expect(second.jobId).not.toBe(first.jobId);
    await completed(second.jobId);
    expect(await command({ kind: "deploy", release: initial, requestId })).toMatchObject({
      jobId: first.jobId,
      state: "succeeded",
    });
    expect(await command({ kind: "read", name: initial.name })).toMatchObject({
      jobId: second.jobId,
    });
    await command(
      {
        kind: "deploy",
        requestId,
        release: {
          ...initial,
          metadata: { ...initial.metadata, compatibility_date: "2026-10-02" },
        },
      },
      400,
    );
    expect(await command({ kind: "read", name: initial.name })).toMatchObject({
      jobId: second.jobId,
    });
  }, 60_000);
  it("activates same-named connectors and secrets independently for organization admins", async () => {
    const scopes = [];

    for (const name of ["alpha", "beta"]) {
      const organizationId = crypto.randomUUID();
      await environment.database.db
        .insert(organization)
        .values({ id: organizationId, name, slug: organizationId, createdAt: new Date() });
      await environment.database.db
        .insert(organizationRuntimes)
        .values({ organizationId, executor: "cloudflare" });
      scopes.push({ organizationId, admin: true });
    }

    const scoped = connectorFixture(
      "shared-scope",
      `import {WorkerEntrypoint} from "cloudflare:workers"; export default class extends WorkerEntrypoint { secret(name) { return this.env.WIDEFLEET_SECRETS.get(name); } }`,
    );

    scoped.metadata.bindings = [];
    scoped.metadata.durable_objects = [];
    scoped.metadata.entrypoints = ["default"];
    const requestId = crypto.randomUUID();
    const operations = [];

    for (const application of scopes) {
      const published = contract.connectorStatus.parse(
        await command({ kind: "deploy", release: scoped, requestId, application }),
      );

      operations.push(published.jobId);
      await completed(published.jobId);

      const secret = contract.connectorStatus.parse(
        await command({
          kind: "secret",
          name: scoped.name,
          secret: "API_KEY",
          value: application.organizationId,
          application,
        }),
      );

      await completed(secret.jobId);
    }

    expect(new Set(operations).size).toBe(2);

    const [accepted] = await environment.database.db
      .select()
      .from(cloudflareOperations)
      .where(eq(cloudflareOperations.id, operations[0] ?? ""));

    if (!accepted) throw new Error("Missing accepted organization connector operation");
    const original = connectorCommand.parse(accepted.command);
    const forged = { ...original, actor: { ...original.actor, application: scopes[1] } };
    const beforeReplay = requests.length;

    for (const action of ["provision", "activate"]) {
      const response = await worker.fetch("http://fixture/replay", {
        method: "POST",
        body: JSON.stringify({ action, command: forged }),
      });

      expect(response.status).toBe(400);
    }

    expect(requests).toHaveLength(beforeReplay);
    // An admission failure must not mark a different accepted operation as failed.
    await environment.database.db
      .update(cloudflareOperations)
      .set({ finishedAt: null })
      .where(eq(cloudflareOperations.id, accepted.id));
    expect(
      (
        await worker.fetch("http://fixture/replay", {
          method: "POST",
          body: JSON.stringify({ action: "fail", command: forged }),
        })
      ).status,
    ).toBe(200);

    const [unmodified] = await environment.database.db
      .select()
      .from(cloudflareOperations)
      .where(eq(cloudflareOperations.id, accepted.id));

    expect(unmodified?.finishedAt).toBeNull();
    expect(unmodified?.error).toBeNull();
    await environment.database.db
      .update(cloudflareOperations)
      .set({ finishedAt: accepted.finishedAt })
      .where(eq(cloudflareOperations.id, accepted.id));

    for (const application of scopes) {
      expect(
        await (
          await worker.fetch(
            `http://fixture/secret?connector=${scoped.name}&execution=${application.organizationId}&name=API_KEY`,
          )
        ).json(),
      ).toBe(application.organizationId);

      const listed = contract.connectorStatus
        .array()
        .parse(await command({ kind: "list", application }));

      expect(listed.map((item) => item.name)).toEqual([scoped.name]);
      await command(
        {
          kind: "secret",
          name: scoped.name,
          secret: "API_KEY",
          value: "denied",
          application: { ...application, admin: false },
        },
        400,
      );
    }
  }, 60_000);
});
