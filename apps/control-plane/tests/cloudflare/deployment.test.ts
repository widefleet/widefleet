import { companyIdentity } from "../../src/lib/server/company-identity.ts";
import { runtimeIdentity } from "../runtime-identity.ts";
import { connectorReference } from "../../src/lib/server/connector-package.ts";
import { connectorFixture } from "../cloudflare-connector.fixture.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Unstable_DevWorker } from "wrangler";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { Result } from "better-result";
import * as contract from "@platform/contracts";
import release from "@platform/app-runtime/release" with { type: "json" };
import { createTestEnvironment } from "../environment.ts";
import { deployHostedRuntime } from "../../tools/hosted-runtime.ts";
import { createCloudflareProvisioner } from "../../src/lib/server/cloudflare-provisioning.ts";
import {
  capabilitiesSource,
  deploymentSource,
  seedDeployment,
} from "../cloudflare-deployment.fixture.ts";
import { cloudflareRemovalId } from "../../src/lib/server/cloudflare-removal-command.ts";
import { user } from "../../src/lib/server/auth-schema.ts";
import { initializeCloudflareRuntime } from "../../src/lib/server/organization-runtime.ts";
import { createCloudflareAppSignIn } from "../../src/lib/server/app-sign-in-cloudflare.ts";
import { createAppService } from "../../src/lib/server/apps.ts";
import {
  apps,
  appGrants,
  artifacts,
  connectors,
  cloudflareOperations,
  cloudflareRuntimeBindings,
  deployments,
  jobs,
  organizationRuntimes,
} from "../../src/lib/server/schema.ts";

const resourceName = (appId: string, kind: string, name: string) =>
  `r${createHash("sha256").update(`${appId}/${kind}/${name}`).digest("hex").slice(0, 40)}`;

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")(
  "Hosted deployment workflow in workerd",
  () => {
    let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
    let directory: string;
    let identity: Awaited<ReturnType<typeof runtimeIdentity>>;
    let worker: Unstable_DevWorker;
    let first: Awaited<ReturnType<typeof seedDeployment>>;
    let preview: Awaited<ReturnType<typeof seedDeployment>>;
    let rejected: Awaited<ReturnType<typeof seedDeployment>>;
    let delayed: Awaited<ReturnType<typeof seedDeployment>>;
    let lostResponse: Awaited<ReturnType<typeof seedDeployment>>;

    let appliedMigration:
      | { id: string; request: z.infer<typeof contract.migrationRequest> }
      | undefined;

    const token = "local-deployment-runtime-token-never-deploy";
    const largeGroups = Array.from({ length: 100 }, (_, index) => `${index}-${"group".repeat(40)}`);
    const databases = new Map<string, string>();
    const createdDatabases = new Set<string>();
    const buckets = new Set<string>();
    const bucketObjects = new Map<string, Set<string>>();
    const deletedResources: string[] = [];
    let failedObjectDelete = false;
    let deniedBucket = "";
    let heldDatabaseName = "";
    let finishDatabaseCreation: (() => void) | undefined;
    let databaseCreates = 0;
    const namespaces = new Map<string, string>();

    const queues = new Map<
      string,
      { queue_id: string; queue_name: string; consumers: z.infer<ReturnType<typeof z.json>>[] }
    >();

    const migrations = new Map<string, DatabaseSync>();
    let schedules: { cron: string }[] = [];
    let scheduleMode = "normal";
    let scheduleWrites = 0;
    let delayedSchedule: (() => void) | undefined;

    const nativeBinding = z.object({
      name: z.string(),
      type: z.string(),
      id: z.string().optional(),
      bucket_name: z.string().optional(),
      namespace_id: z.string().optional(),
      queue_name: z.string().optional(),
      service: z.string().optional(),
      entrypoint: z.string().optional(),
    });

    const settings = new Map<string, z.infer<typeof nativeBinding>>([
      ["WIDEFLEET_PACKAGES", { name: "WIDEFLEET_PACKAGES", type: "r2_bucket" }],
      ["WIDEFLEET_CONTROL_TOKEN", { name: "WIDEFLEET_CONTROL_TOKEN", type: "secret_text" }],
    ]);

    const updates: { name: string; type: string }[][] = [];
    let patches = 0;
    let bindingRequests = 0;
    let bindingMode = "normal";
    let delayedBindingUpdate: (() => void) | undefined;
    let bindingTag = "initial";
    let apiOrigin = "";
    let runtimeVersion = release.version;
    let runtimeUploadMode = "normal";
    let runtimeUploads = 0;
    let runtimeVersionUnavailable = false;

    const api = createServer((request, response) => {
      const handle = async () => {
        const url = new URL(request.url ?? "/", apiOrigin);
        let body = "";

        for await (const chunk of request) body += String(chunk);

        const ok = (
          result:
            | z.infer<ReturnType<typeof z.json>>
            | {
                bindings: z.infer<typeof nativeBinding>[];
                annotations: Record<string, string>;
              },
        ) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ success: true, result }));
        };

        if (request.headers.authorization !== "Bearer local-provisioning-token")
          throw new Error("Incorrect API credential");

        if (url.pathname === "/fixture-runtime-version") {
          if (runtimeVersionUnavailable && !url.searchParams.has("readiness")) {
            response.statusCode = 503;
            response.end();

            return;
          }

          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ runtimeVersion }));
        } else if (url.pathname.endsWith("/workers/scripts/fixture-runtime/content")) {
          expect(request.method).toBe("PUT");

          const multipart = await new Response(body, {
            headers: { "content-type": request.headers["content-type"] ?? "" },
          }).formData();

          expect(JSON.parse(z.string().parse(multipart.get("metadata")))).toEqual({
            main_module: "loader.js",
          });
          expect([...multipart.keys()]).toEqual(["metadata", "loader.js"]);
          const module = multipart.get("loader.js");

          if (!(module instanceof File)) throw new Error("Missing runtime module");
          expect(module.type).toBe("application/javascript+module");
          const version = (await module.text()).match(/runtimeVersion: "([0-9.]+)"/)?.[1];

          if (!version) throw new Error("Runtime module has no version");
          runtimeUploads++;

          if (runtimeUploadMode === "rejected") {
            response.statusCode = 400;
            response.end();

            return;
          }

          runtimeVersion = version;

          if (runtimeUploadMode === "unconfirmed") runtimeVersionUnavailable = true;

          if (runtimeUploadMode === "lost-response") {
            runtimeUploadMode = "normal";
            response.statusCode = 503;
            response.end();
          } else ok({});
        } else if (url.pathname.endsWith("/d1/database")) {
          if (request.method === "GET") {
            ok(
              [...createdDatabases]
                .map((name) => ({ name, uuid: databases.get(name) ?? "" }))
                .slice(
                  (Number(url.searchParams.get("page") ?? 1) - 1) * 100,
                  Number(url.searchParams.get("page") ?? 1) * 100,
                ),
            );
          } else {
            const { name } = z.object({ name: z.string() }).parse(JSON.parse(body));

            if (!databases.has(name) || createdDatabases.has(name))
              throw new Error("Unexpected D1 creation");
            databaseCreates++;

            if (name === heldDatabaseName) {
              finishDatabaseCreation = () => {
                createdDatabases.add(name);
              };

              response.statusCode = 503;
              response.end();
            } else {
              createdDatabases.add(name);
              ok({ name, uuid: databases.get(name) ?? "" });
            }
          }
        } else if (url.pathname.includes("/d1/database/") && request.method === "DELETE") {
          const id = url.pathname.split("/").at(-1);
          const name = [...databases].find(([, value]) => value === id)?.[0];

          if (name) {
            createdDatabases.delete(name);
            deletedResources.push(name);
          }

          ok(null);
        } else if (
          url.pathname.includes("/storage/kv/namespaces/") &&
          request.method === "DELETE"
        ) {
          const id = url.pathname.split("/").at(-1);
          const name = [...namespaces].find(([, value]) => value === id)?.[0];

          if (name) {
            namespaces.delete(name);
            deletedResources.push(name);
          }

          ok(null);
        } else if (url.pathname.endsWith("/query")) {
          const id = url.pathname.split("/").at(-2) ?? "";
          let database = migrations.get(id);

          if (!database) {
            database = new DatabaseSync(":memory:");
            migrations.set(id, database);
          }

          const { sql: query } = z.object({ sql: z.string() }).parse(JSON.parse(body));

          if (query.startsWith("SELECT"))
            ok([{ success: true, results: z.json().parse(database.prepare(query).all()) }]);
          else {
            database.exec("BEGIN");

            try {
              database.exec(query);
              database.exec("COMMIT");
            } catch (error) {
              database.exec("ROLLBACK");
              throw error;
            }

            ok([{ success: true, results: [] }]);
          }
        } else if (url.pathname.endsWith("/storage/kv/namespaces")) {
          if (request.method === "GET")
            ok(
              [...namespaces]
                .map(([title, id]) => ({ title, id }))
                .slice(
                  (Number(url.searchParams.get("page") ?? 1) - 1) * 100,
                  Number(url.searchParams.get("page") ?? 1) * 100,
                ),
            );
          else {
            const { title } = z.object({ title: z.string() }).parse(JSON.parse(body));
            const id = createHash("sha256").update(title).digest("hex").slice(0, 32);
            expect(namespaces.has(title)).toBe(false);
            namespaces.set(title, id);
            ok({ title, id });
          }
        } else if (url.pathname.endsWith("/schedules")) {
          if (request.method === "PUT") {
            const target = z.array(z.object({ cron: z.string() })).parse(JSON.parse(body));
            scheduleWrites++;

            if (target.some((entry) => entry.cron === "61 * * * *")) {
              response.statusCode = 400;
              response.end();

              return;
            }

            const mode = scheduleMode;
            scheduleMode = "normal";

            if (mode === "delayed")
              delayedSchedule = () => {
                schedules = target;
              };
            else schedules = target;

            if (mode !== "normal") {
              response.statusCode = 503;
              response.end();

              return;
            }
          }

          ok({ schedules });
        } else if (url.pathname.endsWith("/queues")) {
          if (request.method === "GET") ok([...queues.values()]);
          else {
            const { queue_name } = z.object({ queue_name: z.string() }).parse(JSON.parse(body));
            expect(queues.has(queue_name)).toBe(false);
            const queue = { queue_name, queue_id: crypto.randomUUID(), consumers: [] };
            queues.set(queue_name, queue);
            ok(queue);
          }
        } else if (url.pathname.includes("/queues/")) {
          const parts = url.pathname.split("/");
          const id = parts[parts.indexOf("queues") + 1];
          const queue = [...queues.values()].find((entry) => entry.queue_id === id);

          if (!queue) throw new Error("Unknown queue");

          if (request.method === "GET") ok(queue);
          else if (request.method === "DELETE") {
            if (parts.includes("consumers")) queue.consumers = [];
            else {
              expect(queue.consumers).toHaveLength(0);
              queues.delete(queue.queue_name);
              deletedResources.push(queue.queue_name);
            }

            ok(null);
          } else {
            const consumer = z.record(z.string(), z.json()).parse(JSON.parse(body));
            const { script_name: script, ...options } = consumer;
            queue.consumers = [
              { ...options, script: z.string().parse(script), consumer_id: "fixture-consumer" },
            ];
            ok(queue.consumers[0] ?? null);
          }
        } else if (url.pathname.endsWith("/r2/buckets")) {
          const { name } = z.object({ name: z.string() }).parse(JSON.parse(body));

          if (buckets.has(name)) throw new Error("Duplicate R2 creation");
          buckets.add(name);
          ok({ name });
        } else if (url.pathname.includes("/r2/buckets/")) {
          const parts = url.pathname.split("/");
          const name = parts[parts.indexOf("buckets") + 1] ?? "";
          const objects = bucketObjects.get(name) ?? new Set<string>();

          if (name === deniedBucket) {
            response.statusCode = 403;
            response.end();
          } else if (!buckets.has(name)) {
            response.statusCode = 404;
            response.end();
          } else if (parts.includes("objects")) {
            if (request.method === "GET") ok([...objects].slice(0, 100).map((key) => ({ key })));
            else {
              objects.delete(decodeURIComponent(parts.at(-1) ?? ""));

              if (failedObjectDelete) {
                failedObjectDelete = false;
                response.statusCode = 503;
                response.end();
              } else ok(null);
            }
          } else if (request.method === "DELETE") {
            expect(objects.size).toBe(0);
            buckets.delete(name);
            deletedResources.push(name);
            ok(null);
          } else ok({ name });
        } else if (url.pathname.endsWith("/settings")) {
          if (request.method === "PATCH") {
            const multipart = await new Response(body, {
              headers: { "content-type": request.headers["content-type"] ?? "" },
            }).formData();

            const { bindings, annotations } = z
              .object({
                bindings: z.array(nativeBinding),
                annotations: z.object({ "workers/tag": z.uuid() }),
              })
              .parse(JSON.parse(z.string().parse(multipart.get("settings"))));

            bindingRequests++;

            const apply = () => {
              const retained = new Map(
                bindings.map((binding) => {
                  const inherited =
                    binding.type === "inherit" ? settings.get(binding.name) : binding;

                  if (!inherited) throw new Error("Unknown inherited binding");

                  return [binding.name, inherited] as const;
                }),
              );

              for (const name of ["WIDEFLEET_PACKAGES", "WIDEFLEET_CONTROL_TOKEN"])
                if (!retained.has(name)) throw new Error(`Shared binding removed: ${name}`);

              settings.clear();

              for (const [name, binding] of retained) settings.set(name, binding);
              updates.push(bindings);
              patches++;
              bindingTag = annotations["workers/tag"];
            };

            const mode = bindingMode;
            bindingMode = "normal";

            if (mode === "delayed") delayedBindingUpdate = apply;
            else apply();

            if (mode !== "normal") {
              response.statusCode = 503;
              response.end();

              return;
            }
          }

          ok({ bindings: [...settings.values()], annotations: { "workers/tag": bindingTag } });
        } else throw new Error("Unexpected API request");
      };

      void handle().catch((error) => {
        console.error(error);
        response.statusCode = 500;
        response.end();
      });
    });

    const start = async () => {
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

    const authenticatedFetch = (
      url: string,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", identity.cookie);

      return worker.fetch(url, { ...init, headers: Object.fromEntries(headers) });
    };

    const managementFetch = (
      url: string,
      init?: { method?: string; body?: string | null; headers?: Record<string, string> },
    ) =>
      worker.fetch(url, { ...init, headers: { ...init?.headers, "x-fixture-management": "true" } });

    const publishIdentity = async () => {
      expect(
        (
          await managementFetch(
            "https://auth.apps.example.test/.well-known/widefleet/auth/organizations/widefleet/configuration",
            {
              method: "PUT",
              headers: { authorization: `Bearer ${token}` },
              body: JSON.stringify(identity.configuration),
            },
          )
        ).status,
      ).toBe(204);
    };

    const seed = async (entry: typeof first) => {
      const response = await worker.fetch("http://fixture/seed", {
        method: "POST",
        body: JSON.stringify({ artifact: entry.artifact, source: entry.source }),
      });

      expect(response.status).toBe(204);
    };

    const submit = async (entry: typeof first, mode = "") => {
      return worker.fetch(`http://fixture/start?mode=${mode}`, {
        method: "POST",
        body: JSON.stringify(entry.command),
      });
    };

    const dispatch = async (entry: typeof first, mode = "") => {
      expect((await submit(entry, mode)).status).toBe(200);
    };

    const configure = async (
      appId: string,
      kind: "access" | "network",
      input: z.infer<typeof contract.appAccessChange> | z.infer<typeof contract.networkChange>,
    ) => {
      const response = await worker.fetch("http://fixture/start", {
        method: "POST",
        body: JSON.stringify({
          kind,
          appId,
          actor: { id: "fixture-owner", admin: false, application: environment.application },
          input,
        }),
      });

      expect(response.status).toBe(200);

      const [record] = await environment.database.db
        .select()
        .from(cloudflareOperations)
        .where(eq(cloudflareOperations.appId, appId))
        .orderBy(desc(cloudflareOperations.sequence))
        .limit(1);

      if (!record) throw new Error("Missing configuration history");
      await completed(record.id);
    };

    const host = async (hostname: string) => {
      const response = await worker.fetch(`http://fixture/host?hostname=${hostname}`);

      return z
        .object({ body: z.unknown(), access: z.string().nullable() })
        .nullable()
        .parse(await response.json());
    };

    const operation = async (id: string) => {
      const [record] = await environment.database.db
        .select()
        .from(cloudflareOperations)
        .where(eq(cloudflareOperations.id, id));

      return record;
    };

    const nativeStatus = async (id: string) => {
      const response = await worker.fetch(`http://fixture/workflow?id=${id}`);

      return z.object({ status: z.string() }).parse(await response.json()).status;
    };

    const completed = async (id: string) => {
      await expect
        .poll(
          async () => ({
            done: (await operation(id))?.finishedAt !== null,
            status: await nativeStatus(id),
          }),
          { timeout: 90_000, interval: 100 },
        )
        .toEqual({ done: true, status: "complete" });
    };

    const bindConnector = async (
      appId: string,
      name: string,
      grant: z.infer<typeof contract.capabilityGrant> | null,
    ) => {
      const response = await worker.fetch("http://fixture/start", {
        method: "POST",
        body: JSON.stringify({
          kind: "capabilities",
          appId,
          name,
          grant,
          actor: {
            id: "fixture-owner",
            admin: true,
            application: { ...environment.application, admin: true },
          },
        }),
      });

      expect(response.status).toBe(200);

      const [record] = await environment.database.db
        .select()
        .from(cloudflareOperations)
        .where(eq(cloudflareOperations.appId, appId))
        .orderBy(desc(cloudflareOperations.sequence))
        .limit(1);

      if (!record) throw new Error("Missing binding history");
      await completed(record.id);
    };

    beforeAll(async () => {
      identity = await runtimeIdentity("example.test", [
        "engineering",
        "support",
        largeGroups[0] ?? "",
      ]);
      environment = await createTestEnvironment();
      (await initializeCloudflareRuntime(environment.database.db)).unwrap();
      await environment.database.db
        .update(organizationRuntimes)
        .set({ appHostnameSuffix: "fixture" })
        .where(eq(organizationRuntimes.organizationId, environment.application.organizationId));

      const applications = createAppService(environment.database.db, {
        ...environment.configuration,
        APP_DOMAIN: "example.test",
      });

      const principal = {
        id: "fixture-owner",
        name: "Fixture",
        email: "fixture@example.test",
        role: "admin" as const,
        admin: true,
        creator: true,
        application: { ...environment.application, admin: true },
      };

      const parentApp = (
        await applications.create(principal, {
          slug: "notes",
          displayName: "Notes",
          parentId: null,
        })
      ).unwrap();

      const previewApp = (
        await applications.create(principal, {
          slug: "notes-review",
          displayName: "Review",
          parentId: parentApp.id,
          previewName: "review",
        })
      ).unwrap();

      first = await seedDeployment(environment.database.db, { appId: parentApp.id });
      preview = await seedDeployment(environment.database.db, { appId: previewApp.id });

      for (const [id, groups] of [
        [parentApp.id, ["engineering"]],
        [previewApp.id, largeGroups],
      ] as const)
        await environment.database.db
          .update(apps)
          .set({ accessRevision: 1, accessGroups: [...groups] })
          .where(eq(apps.id, id));
      delayed = await seedDeployment(environment.database.db);
      lostResponse = await seedDeployment(environment.database.db);

      for (const entry of [first, preview, delayed, lostResponse])
        databases.set(resourceName(entry.appId, "d1", "data"), crypto.randomUUID());
      directory = await mkdtemp(join(tmpdir(), "widefleet-deployment-workerd-"));
      api.listen(0, "127.0.0.1");
      await once(api, "listening");
      apiOrigin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(api.address()).port}`;
      await writeFile(join(directory, "runtime.js"), release.modules[0]?.source ?? "");
      const workflow = fileURLToPath(new URL("../../src/deployment-workflow.ts", import.meta.url));

      const appOperation = fileURLToPath(
        new URL("../../src/app-operation-workflow.ts", import.meta.url),
      );

      const server = fileURLToPath(new URL("../../src/lib/server/", import.meta.url));

      await writeFile(
        join(directory, "fixture.ts"),
        `
      import runtime, { RuntimeManagement as BaseManagement } from './runtime.js';
      import {WorkerEntrypoint} from 'cloudflare:workers';
      export class ConnectorGateway extends WorkerEntrypoint { invoke(method, args) { if (method !== 'read' || args.length) throw new Error('Unexpected fixture RPC'); return this.ctx.props.entrypoint === 'Reader' ? 'named-connector' : 'default-connector'; } }
      import {createConnectorService} from ${JSON.stringify(server + "connectors.ts")};
      import {prepareConnector} from ${JSON.stringify(server + "connector-changes.ts")};
      import {lockOrganizationRuntime} from ${JSON.stringify(server + "organization-runtime.ts")};
      import { createCloudflareDeployment } from ${JSON.stringify(server + "cloudflare-deployment.ts")};
      import { createCloudflareEvents } from ${JSON.stringify(server + "cloudflare-events.ts")};
      import { createCloudflareProvisioner } from ${JSON.stringify(server + "cloudflare-provisioning.ts")};
      import { createCloudflareExecution } from ${JSON.stringify(server + "cloudflare-execution.ts")};
      import { withCloudflareDatabase } from ${JSON.stringify(server + "cloudflare-database.ts")};
      import { createArtifactStorage } from ${JSON.stringify(server + "artifact-storage.ts")};
      import { createR2Storage } from ${JSON.stringify(server + "storage/r2.ts")};
      import { createAppService } from ${JSON.stringify(server + "apps.ts")};
      import { createRuntimeReleaseService } from ${JSON.stringify(server + "runtime-releases.ts")};
      import { readCloudflareConfiguration } from ${JSON.stringify(server + "cloudflare-config.ts")};
      export * from './runtime.js';
      export { DeploymentWorkflow } from ${JSON.stringify(workflow)};
      export { AppOperationWorkflow } from ${JSON.stringify(appOperation)};
      import { createMigrationService } from ${JSON.stringify(server + "migrations.ts")};
      import { createWorkflowService } from ${JSON.stringify(server + "workflows.ts")};
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        return nativeFetch(url.origin === 'https://api.cloudflare.com' ? new Request(${JSON.stringify(apiOrigin)} + url.pathname + url.search, request) : request);
      };
      export class RuntimeManagement extends BaseManagement {
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/.well-known/widefleet/runtime')
            return nativeFetch(${JSON.stringify(apiOrigin)} + '/fixture-runtime-version', {headers:{authorization:'Bearer local-provisioning-token'}});
          const response = await super.fetch(request);
          if (url.pathname === '/.well-known/widefleet/ready' && response.ok) {
            const version = await nativeFetch(${JSON.stringify(apiOrigin)} + '/fixture-runtime-version?readiness', {headers:{authorization:'Bearer local-provisioning-token'}});
            return Response.json({...await response.json(), ...await version.json()});
          }
          return response;
        }
      }
      export default { ...runtime, async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.hostname !== "fixture") { url.protocol = "https:"; url.port = ""; request = new Request(url, request); }
        if (request.headers.get('x-fixture-management') === 'true') {
          request.headers.delete('x-fixture-management');
          return env.APP_RUNTIME.fetch(request);
        }
        if (url.hostname === 'fixture' && url.pathname === '/runtime') {
          const input = request.method === 'GET' ? null : await request.json();
          const result = await withCloudflareDatabase(env, ({db}) => {
            const storage = createArtifactStorage(createR2Storage(env.ARTIFACTS));
            const deployments = {
              async create(options) {
                const modifier = await env.DEPLOYMENTS.unsafeGetInstanceModifier(options.id);
                try { await modifier.disableRetryDelays(); } finally { modifier[Symbol.dispose]?.(); }
                return env.DEPLOYMENTS.create(options);
              },
              get: id => env.DEPLOYMENTS.get(id),
            };
            const service = createRuntimeReleaseService(db, storage, createCloudflareExecution({...env, DEPLOYMENTS:deployments}, db, storage));
            const principal = {id:'fixture-owner',admin:!url.searchParams.has('nonadmin'), application: {...${JSON.stringify(environment.application)}, admin:!url.searchParams.has('nonadmin')}};
            return input === null ? service.read(principal) : 'modules' in input ? service.install(principal,input) : service.rollback(principal,input);
          });
          return Response.json(result.isErr() ? {error:result.error.message} : result.value, {status:result.isErr()?400:200});
        }
        if (url.hostname === 'fixture' && url.pathname === '/prepare-connector') {
          const input = await request.json();
          try {
            await withCloudflareDatabase(env, ({db}) => db.transaction(async transaction => {
              const execution = await lockOrganizationRuntime(transaction, input.organizationId);
              await prepareConnector(transaction, createArtifactStorage(createR2Storage(env.ARTIFACTS)), execution, input.release);
            }));
            return new Response(null, {status:204});
          } catch(error) {return Response.json({error:error.message}, {status:400});}
        }
        if (url.hostname === 'fixture' && url.pathname === '/seed') {
          const { artifact, source } = await request.json();
          await env.ARTIFACTS.put('apps/' + artifact.appId + '/modules/' + artifact.modules[0].sha256, source);
          return new Response(null, { status: 204 });
        }
        if (url.hostname === 'fixture' && url.pathname === '/start') {
          const command = await request.json();
          if (url.searchParams.get('mode') === 'register-only') {
            await createCloudflareDeployment(env).register(command);
            return new Response(null, {status:200});
          }
          // Miniflare's testing API skips backoff time, while every real step attempt still runs.
          if (url.searchParams.get('mode') === 'fast-retries') {
            const modifier = await env.DEPLOYMENTS.unsafeGetInstanceModifier(command.id);
            try { await modifier.disableRetryDelays(); }
            finally { modifier[Symbol.dispose]?.(); }
          }
          if (url.searchParams.get('mode') === 'accepted-only') {
            await env.DEPLOYMENTS.create({ id: command.id, params: command });
            return new Response(null, { status: 200 });
          }
          const deploymentBinding = {
            async create(options) {
              if (url.searchParams.get('mode') === 'unavailable') throw new Error('Fixture unavailable');
              const instance = await env.DEPLOYMENTS.create(options);
              if (url.searchParams.get('mode') === 'lost-response') throw new Error('Fixture lost response');
              return instance;
            },
            get: (id) => env.DEPLOYMENTS.get(id),
          };
          const result = await withCloudflareDatabase(env, async ({ db }) => {
            const executor = createCloudflareExecution({ ...env, DEPLOYMENTS: deploymentBinding }, db, createArtifactStorage(createR2Storage(env.ARTIFACTS)));
            if (command.kind === 'capabilities') return executor.connectors.bind(command.actor, command.appId, command.name, command.grant);
            if (command.kind === 'access') return executor.access(command.actor, command.appId, command.input);
            if (command.kind === 'network') return executor.network(command.actor, command.appId, command.input);
            return executor.deploy({ id: command.id, appId: command.appId, artifactId: command.artifactId, createdAt: command.createdAt,
              status: 'queued', finishedAt: null, message: null }, command.requestId, command.rollback);
          });
          return Response.json(result.isErr() ? { error: result.error.message } : result.value, { status: result.isErr() ? 400 : 200 });
        }
        if (url.hostname === 'fixture' && url.pathname === '/remove') {
          const input = await request.json();
          const modifier = await env.APP_OPERATIONS.unsafeGetInstanceModifier(input.id);
          try { await modifier.disableRetryDelays(); } finally { modifier[Symbol.dispose]?.(); }
          const operations = input.unavailable ? { create(){throw new Error('Unavailable');}, get(){throw new Error('Unavailable');} } : env.APP_OPERATIONS;
          const result = await withCloudflareDatabase(env, async ({db}) => {
            const execution = createCloudflareExecution({...env,APP_OPERATIONS:operations}, db, createArtifactStorage(createR2Storage(env.ARTIFACTS)));
            return createAppService(db, readCloudflareConfiguration(env), execution).remove({id:input.actor ?? 'fixture-owner',admin:false, application:${JSON.stringify(environment.application)}}, input.appId);
          });
          return Response.json(result.isErr() ? {error:result.error.message} : result.value, {status:result.isErr()?400:200});
        }
        if (url.hostname === 'fixture' && url.pathname === '/storage') {
          if (request.method === 'PUT') {
            await env.ARTIFACTS.put(url.searchParams.get('key'), await request.text());
            return new Response(null,{status:204});
          }
          if (request.method === 'DELETE') {
            await env.ARTIFACTS.delete(url.searchParams.get('key'));
            return new Response(null,{status:204});
          }
          return Response.json((await env.ARTIFACTS.list({prefix:url.searchParams.get('prefix') ?? ''})).objects.map(object=>object.key));
        }
        if (url.hostname === 'fixture' && url.pathname === '/stale-publication') {
          const input = await request.json();
          const written = await env.ARTIFACTS.put('hosts/'+input.hostname+'.json',JSON.stringify(input.app),{onlyIf:{etagDoesNotMatch:'*'}});
          return Response.json({written:written!==null});
        }
        if (url.hostname === 'fixture' && url.pathname === '/stale-stage') {
          const input = await request.json();
          try {
            await withCloudflareDatabase(env,({db})=>createCloudflareEvents(env.ARTIFACTS,db,createCloudflareProvisioner({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN,runtimeName:env.APP_RUNTIME_NAME}),env.APP_RUNTIME_NAME).stage(input.id,input.app,input.sequence));
            return new Response(null,{status:204});
          } catch {return new Response(null,{status:409});}
        }
        if (url.hostname === 'fixture' && url.pathname === '/stale-provision') {
          try {await createCloudflareDeployment(env).provision(await request.json());return new Response(null,{status:204});}
          catch {return new Response(null,{status:409});}
        }
        if (url.hostname === 'fixture' && url.pathname === '/raw-operation') {
          const command = await request.json();
          const modifier = await env.APP_OPERATIONS.unsafeGetInstanceModifier(command.id);
          try { await modifier.disableRetryDelays(); } finally { modifier[Symbol.dispose]?.(); }
          await env.APP_OPERATIONS.create({id:command.id,params:command});
          return new Response(null,{status:204});
        }
        if (url.hostname === 'fixture' && url.pathname === '/operation') {
          const input = await request.json();
          const result = await withCloudflareDatabase(env, async ({db}) => {
            const storage = createArtifactStorage(createR2Storage(env.ARTIFACTS));
            const operations = input.expired ? { create(){throw new Error('Expired native operation must not be recreated');}, get(){throw new Error('Expired native operation must not be read');} } : env.APP_OPERATIONS;
            const execution = createCloudflareExecution({...env,APP_OPERATIONS:operations}, db, storage);
            const service = input.kind === 'migrations' ? createMigrationService(db, storage, execution) : createWorkflowService(db, execution);
            const principal = { id: input.actor ?? 'fixture-owner', admin: false, creator: true, name: 'Fixture', email: 'fixture@example.test', role: 'member', application:${JSON.stringify(environment.application)} };
            if (input.read) return service.read(principal, input.appId, input.id);
            return service.create(principal, input.appId, input.id, input.request);
          });
          return Response.json(result.isErr() ? {error: result.error.message} : result.value, {status:result.isErr()?400:200});
        }
        if (url.hostname === 'fixture' && url.pathname === '/cron') {
          await runtime.scheduled({cron:url.searchParams.get('cron'),scheduledTime:Date.now(), noRetry(){}}, env, ctx);
          return new Response(null, {status:204});
        }
        if (url.hostname === 'fixture' && url.pathname === '/history') {
          const result = await withCloudflareDatabase(env, async ({ db }) => {
            const executor = createCloudflareExecution(env, db, createArtifactStorage(createR2Storage(env.ARTIFACTS)));
            return createAppService(db, readCloudflareConfiguration(env), executor).history({ id: 'fixture-owner', admin: true, application: {...${JSON.stringify(environment.application)}, admin:true} }, url.searchParams.get('appId'));
          });
          return Response.json(result.unwrap());
        }
        if (url.hostname === 'fixture' && url.pathname === '/connections') {
          const result = await withCloudflareDatabase(env, async ({db}) => createConnectorService(db, createArtifactStorage(createR2Storage(env.ARTIFACTS)), env.PLATFORM_ENCRYPTION_KEY).connections({id:'fixture-owner', admin:true, application: {...${JSON.stringify(environment.application)}, admin:true}}, url.searchParams.get('appId')));
          return Response.json(result.unwrap());
        }
        if (url.hostname === 'fixture' && url.pathname === '/host') {
          const obj = await env.ARTIFACTS.get('hosts/' + url.searchParams.get('hostname') + '.json');
          const route = await env.AUTH_CONFIG.get('apps/' + url.searchParams.get('hostname'), 'json');
          return Response.json(obj ? { body: await obj.json(), access: route ? JSON.stringify(route.access) : null } : null);
        }
        if (url.hostname === 'fixture' && url.pathname === '/workflow') {
          const instance = await (url.searchParams.has('app-operation') ? env.APP_OPERATIONS : env.DEPLOYMENTS).get(url.searchParams.get('id'));
          if (request.method === 'POST') {
            if (url.searchParams.get('action') === 'pause') await instance.pause();
            else if (url.searchParams.get('action') === 'restart') await instance.restart();
            else await instance.resume();
          }
          return Response.json(await instance.status());
        }
        return runtime.fetch(request, env, ctx);
      } };
    `,
      );
      await writeFile(
        join(directory, "wrangler.json"),
        JSON.stringify({
          name: "widefleet-deployment-test",
          main: "fixture.ts",
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          vars: {
            ...environment.environment,
            CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
            CLOUDFLARE_API_TOKEN: "local-provisioning-token",
            APP_RUNTIME_NAME: "fixture-runtime",
            WIDEFLEET_CONTROL_TOKEN: token,
            WIDEFLEET_CONFIGURATION: JSON.stringify({ source: "r2" }),
          },
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
              name: "fixture-deployments",
              class_name: "DeploymentWorkflow",
            },
            {
              binding: "APP_OPERATIONS",
              name: "fixture-app-operations",
              class_name: "AppOperationWorkflow",
            },
            {
              binding: "WIDEFLEET_WORKFLOWS",
              name: "fixture-app-workflows",
              class_name: "CloudflareAppWorkflow",
            },
          ],
          durable_objects: {
            bindings: [
              { name: "WIDEFLEET_WORKFLOW_CATALOG", class_name: "CloudflareWorkflowCatalog" },
            ],
          },
          migrations: [{ tag: "v1", new_sqlite_classes: ["CloudflareWorkflowCatalog"] }],
          kv_namespaces: [
            { binding: "AUTH_CONFIG", id: "auth-config" },
            ...[first, preview].map((entry) => ({
              binding: `B_${resourceName(entry.appId, "kv", "cache")}`,
              id: createHash("sha256")
                .update(resourceName(entry.appId, "kv", "cache"))
                .digest("hex")
                .slice(0, 32),
            })),
          ],
          queues: {
            producers: [first, preview].map((entry) => ({
              binding: `B_${resourceName(entry.appId, "queue", "jobs")}`,
              queue: resourceName(entry.appId, "queue", "jobs"),
            })),
            consumers: [first, preview].map((entry) => ({
              queue: resourceName(entry.appId, "queue", "jobs"),
              max_batch_size: 1,
              max_batch_timeout: 0,
            })),
          },
          services: [
            {
              binding: "APP_RUNTIME",
              service: "widefleet-deployment-test",
              entrypoint: "RuntimeManagement",
            },
          ],
          worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
          r2_buckets: [
            { binding: "ARTIFACTS", bucket_name: "artifacts" },
            { binding: "WIDEFLEET_PACKAGES", bucket_name: "artifacts" },
            ...[first, preview, delayed, lostResponse].map((entry) => ({
              binding: `B_${resourceName(entry.appId, "r2", "files")}`,
              bucket_name: resourceName(entry.appId, "r2", "files"),
            })),
          ],
          d1_databases: [...databases].map(([name, id]) => ({
            binding: `B_${name}`,
            database_name: name,
            database_id: id,
          })),
        }),
      );
      worker = await start();
      await publishIdentity();
      await seed(first);
      await seed(preview);
      await seed(delayed);
      await seed(lostResponse);
    }, 45_000);
    afterAll(async () => {
      await worker?.stop();
      api.close();

      for (const database of migrations.values()) database.close();
      await environment?.close();

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("publishes hosted sign-in configuration explicitly and keeps reads from replacing it", async () => {
      const service = createCloudflareAppSignIn(environment.configuration, {
        APP_RUNTIME: { fetch: managementFetch },
        APP_COOKIE_SECRET: Buffer.alloc(32, 1).toString("base64url"),
      });

      const client = {
        clientId: "fixture-app-client",
        clientSecret: "fixture-client-secret",
      };

      const identity = companyIdentity.parse({
        provider: { type: "oidc", issuer: "https://identity.example.test", label: "Fixture" },
        management: client,
      });

      const original = await service.revision(identity, "fixture-client-secret");
      expect(await service.status(original)).toMatchObject({ state: "active" });
      expect(await service.publish(identity, "fixture-client-secret")).toBe(original);
      expect(await service.status(original)).toMatchObject({ state: "active", revision: original });

      const rotated = await service.publish(identity, "rotated-client-secret");
      expect(rotated).not.toBe(original);
      expect(await service.revision(identity, "fixture-client-secret")).toBe(original);
      expect(await service.status(rotated)).toMatchObject({ state: "active", revision: rotated });
      expect(await service.plan(identity)).toMatchObject({ restartRequired: false });
      await publishIdentity();
    });

    it("provisions, verifies and activates apps with isolated native D1/R2 data", async () => {
      expect(first.hostname).toBe("notes-fixture.example.test");
      expect(preview.hostname).toBe("review-notes-fixture.example.test");
      await Promise.all([dispatch(first), dispatch(preview)]);
      await completed(first.command.id);
      await completed(preview.command.id);
      expect((await operation(first.command.id))?.targets).toEqual([
        expect.objectContaining({ appId: first.appId, publicationStarted: true }),
      ]);
      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
      expect(createdDatabases.size).toBe(2);
      expect(buckets.size).toBe(2);
      expect(patches).toBe(2);

      expect(updates[1]?.filter((binding) => binding.type === "inherit")).toHaveLength(4);

      for (const entry of [first, preview])
        for (const kind of ["d1", "r2"])
          expect(
            settings.has(`B_${resourceName(entry.appId, kind, kind === "d1" ? "data" : "files")}`),
          ).toBe(true);

      expect(settings.size).toBe(6);
      expect(await host(first.hostname)).toMatchObject({
        body: { deploymentId: first.deploymentId },
        access: JSON.stringify({ revision: 1, groups: ["engineering"] }),
      });
      expect((await host(preview.hostname))?.access).toBe(
        JSON.stringify({ revision: 1, groups: largeGroups }),
      );

      const response = await authenticatedFetch(`https://${first.hostname}/resources`, {
        method: "PUT",
        body: "production fixture",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        rows: [{ value: "production fixture" }],
        file: "production fixture",
      });
      const isolated = await authenticatedFetch(`https://${preview.hostname}/resources`);
      expect(await isolated.json()).toEqual({ rows: [], file: null });
    }, 100_000);

    it("rejects an auth route for a different app reusing the hostname", async () => {
      const route = (appId: string) =>
        managementFetch(
          `https://auth.apps.example.test/.well-known/widefleet/auth/apps/${first.hostname}`,
          {
            method: "PUT",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({
              organizationId: first.organizationId,
              appId,
              access: { revision: 1, groups: ["engineering"] },
            }),
          },
        );

      expect((await route(preview.appId)).status).toBe(204);
      expect((await authenticatedFetch(`https://${first.hostname}/resources`)).status).toBe(503);
      expect((await route(first.appId)).status).toBe(204);

      const matching = await authenticatedFetch(`https://${first.hostname}/resources`, {
        headers: { "x-widefleet-app-id": preview.appId },
      });

      expect(matching.status).toBe(200);
    });

    it("applies access rules to the app and its preview without replacing their code", async () => {
      const original = (await host(first.hostname))?.body;
      const originalPreview = (await host(preview.hostname))?.body;
      await environment.database.db
        .update(apps)
        .set({ parentId: first.appId })
        .where(eq(apps.id, preview.appId));
      await configure(first.appId, "access", { revision: 1, groups: ["support"] });
      expect((await host(first.hostname))?.body).toMatchObject({
        deploymentId: z.object({ deploymentId: z.string() }).parse(original).deploymentId,
      });
      expect((await host(preview.hostname))?.body).toMatchObject({
        deploymentId: z.object({ deploymentId: z.string() }).parse(originalPreview).deploymentId,
      });

      for (const entry of [first, preview])
        expect((await host(entry.hostname))?.access).toBe(
          JSON.stringify({ revision: 2, groups: ["support"] }),
        );
      expect(patches).toBe(2);
      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    });

    it("does not create SQL deployment history when Workflows refuses the command", async () => {
      const entry = await seedDeployment(environment.database.db, { appId: first.appId });
      await seed(entry);
      expect((await submit(entry, "unavailable")).status).toBe(400);
      expect(await operation(entry.command.id)).toBeUndefined();
      expect(
        await environment.database.db
          .select()
          .from(deployments)
          .where(eq(deployments.id, entry.command.id)),
      ).toHaveLength(0);
      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    });

    it("recovers a lost acceptance response and binds API retries to the original input", async () => {
      const entry = await seedDeployment(environment.database.db, { appId: first.appId });
      await seed(entry);
      expect((await submit(entry, "lost-response")).status).toBe(200);
      await completed(entry.command.id);
      const before = patches;
      await dispatch(entry);
      expect(patches).toBe(before);
      const different = await seedDeployment(environment.database.db, { appId: first.appId });
      expect(
        (
          await submit({
            ...different,
            command: {
              ...different.command,
              id: entry.command.id,
              requestId: entry.command.requestId,
            },
          })
        ).status,
      ).toBe(400);
    });

    it("records and completes an accepted command when the request never writes SQL history", async () => {
      const entry = await seedDeployment(environment.database.db, { appId: preview.appId });
      await seed(entry);
      expect((await submit(entry, "accepted-only")).status).toBe(200);
      await completed(entry.command.id);
      expect((await host(entry.hostname))?.body).toMatchObject({ deploymentId: entry.command.id });
      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    });

    it("saves settings before the first deployment without reporting an installation failure", async () => {
      const appId = crypto.randomUUID();
      const id = crypto.randomUUID();
      const hostname = `fixture-${appId}.example.test`;
      await environment.database.db.insert(apps).values({
        id: appId,
        slug: `fixture-${appId}`,
        displayName: "Unstarted fixture",
        organizationId: first.organizationId,
        ownerId: "fixture-owner",
        hostname,
        accessRevision: 1,
        accessGroups: ["engineering"],
        networkRevision: 1,
      });

      const command = {
        id,
        appId,
        kind: "network",
        actor: { id: "fixture-owner", admin: false, application: environment.application },
        input: { target: "backend", action: "allow", origins: ["https://example.com"] },
        createdAt: new Date().toISOString(),
      };

      expect(
        (
          await worker.fetch("http://fixture/start?mode=accepted-only", {
            method: "POST",
            body: JSON.stringify(command),
          })
        ).status,
      ).toBe(200);
      await completed(id);
      const [app] = await environment.database.db.select().from(apps).where(eq(apps.id, appId));
      expect(app).toMatchObject({
        activeDeploymentId: null,
        appliedAccessRevision: null,
        appliedNetworkRevision: null,
        accessError: null,
        networkError: null,
      });
      expect(await host(hostname)).toBeNull();
    });

    it("rejects grants to undeployed connector entrypoints without publishing them", async () => {
      const before = await host(first.hostname);
      const entry = await seedDeployment(environment.database.db, { appId: first.appId });
      await environment.database.db
        .update(apps)
        .set({ capabilities: { CONNECTOR: { connector: "fixture", entrypoint: "default" } } })
        .where(eq(apps.id, first.appId));

      try {
        await seed(entry);
        expect((await submit(entry)).status).toBe(400);
        expect(await host(first.hostname)).toEqual(before);
      } finally {
        await environment.database.db
          .update(apps)
          .set({ capabilities: {} })
          .where(eq(apps.id, first.appId));
      }
    });

    it("keeps the active version when the candidate cannot start", async () => {
      const before = await host(first.hostname);

      const entry = await seedDeployment(environment.database.db, {
        appId: first.appId,
        source: "export default { fetch: invalid syntax };",
      });

      rejected = entry;

      await seed(entry);
      await dispatch(entry, "fast-retries");
      await expect
        .poll(() => nativeStatus(entry.command.id), { timeout: 30_000, interval: 100 })
        .toBe("errored");
      expect((await operation(entry.command.id))?.error).toBeTruthy();
      expect(await host(first.hostname)).toEqual(before);
      expect(await (await authenticatedFetch(`https://${first.hostname}/`)).text()).toBe(
        "deployed fixture",
      );
    }, 40_000);

    it("recovers activation after a SQL failure and a workerd restart", async ({
      onTestFinished,
    }) => {
      const entry = await seedDeployment(environment.database.db, {
        appId: first.appId,
        source: deploymentSource.replace("deployed fixture", "second version"),
      });

      await seed(entry);
      await environment.database.db.execute(
        sql.raw(
          `CREATE FUNCTION fixture_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${entry.command.id}' AND NEW.status = 'succeeded' THEN RAISE EXCEPTION 'fixture completion failure'; END IF; RETURN NEW; END $$`,
        ),
      );
      await environment.database.db.execute(
        sql`CREATE TRIGGER fixture_receipt BEFORE UPDATE ON deployment FOR EACH ROW EXECUTE FUNCTION fixture_reject_receipt()`,
      );
      onTestFinished(async () => {
        await environment.database.db.execute(
          sql`DROP TRIGGER IF EXISTS fixture_receipt ON deployment`,
        );
      });
      await dispatch(entry);
      await expect
        .poll(async () => (await host(entry.hostname))?.body, { timeout: 30_000, interval: 100 })
        .toMatchObject({ deploymentId: entry.deploymentId });
      expect(await nativeStatus(entry.command.id)).not.toBe("complete");
      await configure(first.appId, "network", {
        target: "backend",
        action: "allow",
        origins: ["https://api.example.test"],
      });
      expect((await host(first.hostname))?.body).toMatchObject({
        deploymentId: entry.command.id,
        network: { revision: 1, policy: { backend: ["https://api.example.test"] } },
      });
      const workflowUrl = `http://fixture/workflow?id=${entry.command.id}`;
      await worker.fetch(`${workflowUrl}&action=pause`, { method: "POST" });
      await expect
        .poll(async () => {
          const response = await worker.fetch(workflowUrl);

          return z.object({ status: z.string() }).parse(await response.json()).status;
        })
        .toBe("paused");

      const [pausedDeployment] = await environment.database.db
        .select()
        .from(deployments)
        .where(eq(deployments.id, entry.command.id));

      expect(pausedDeployment?.status).toBe("running");
      expect((await operation(entry.command.id))?.error).toBeNull();
      await worker.stop();
      await environment.database.db.execute(sql`DROP TRIGGER fixture_receipt ON deployment`);
      worker = await start();
      await worker.fetch(`${workflowUrl}&action=resume`, { method: "POST" });
      await dispatch(entry);
      await completed(entry.command.id);
      expect(createdDatabases.size).toBe(2);
      expect(buckets.size).toBe(2);

      const [active] = await environment.database.db
        .select()
        .from(apps)
        .where(eq(apps.id, first.appId));

      expect(active?.activeDeploymentId).toBe(entry.deploymentId);
      expect(active?.appliedNetworkRevision).toBe(1);
      expect((await host(first.hostname))?.body).toMatchObject({
        network: { revision: 1, policy: { backend: ["https://api.example.test"] } },
      });
      expect(await (await authenticatedFetch(`https://${first.hostname}/`)).text()).toBe(
        "second version",
      );

      const [status] = await environment.database.db
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, entry.deploymentId), eq(deployments.status, "succeeded")));

      expect(status).toBeDefined();
    }, 100_000);

    it("keeps other apps independent and restarts failed activation only on an explicit command", async ({
      onTestFinished,
    }) => {
      const entry = await seedDeployment(environment.database.db, {
        appId: first.appId,
        source: deploymentSource.replace("deployed fixture", "third version"),
      });

      const next = await seedDeployment(environment.database.db, { appId: preview.appId });
      await seed(entry);
      await seed(next);
      await environment.database.db.execute(sql`CREATE SEQUENCE fixture_failure_attempts`);
      await environment.database.db.execute(
        sql.raw(
          `CREATE OR REPLACE FUNCTION fixture_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${entry.command.id}' AND NEW.status = 'succeeded' THEN PERFORM nextval('fixture_failure_attempts'); RAISE EXCEPTION 'fixture completion failure'; END IF; RETURN NEW; END $$`,
        ),
      );
      await environment.database.db.execute(
        sql`CREATE TRIGGER fixture_receipt BEFORE UPDATE ON deployment FOR EACH ROW EXECUTE FUNCTION fixture_reject_receipt()`,
      );
      onTestFinished(async () => {
        await environment.database.db.execute(
          sql`DROP TRIGGER IF EXISTS fixture_receipt ON deployment`,
        );
      });
      await dispatch(entry, "fast-retries");
      await expect
        .poll(
          async () => {
            const response = await worker.fetch(`http://fixture/workflow?id=${entry.command.id}`);

            return z.object({ status: z.string() }).parse(await response.json()).status;
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe("errored");
      expect((await operation(entry.command.id))?.error).toBeTruthy();

      const attempts = await environment.database.db.execute(
        sql`SELECT last_value FROM fixture_failure_attempts`,
      );

      expect(z.object({ last_value: z.coerce.number() }).parse(attempts.rows[0]).last_value).toBe(
        6,
      );
      await environment.database.db
        .update(deployments)
        .set({ status: "running", finishedAt: null, message: null })
        .where(eq(deployments.id, entry.command.id));
      const history = await worker.fetch(`http://fixture/history?appId=${entry.appId}`);
      expect(await history.json()).toContainEqual(
        expect.objectContaining({ id: entry.command.id, status: "failed" }),
      );
      await dispatch(next);
      await completed(next.command.id);
      await dispatch(entry);
      expect(await nativeStatus(entry.command.id)).toBe("errored");
      expect((await host(entry.hostname))?.body).toMatchObject({
        deploymentId: entry.deploymentId,
      });
      const prepared = patches;
      await environment.database.db.execute(sql`DROP TRIGGER fixture_receipt ON deployment`);
      await worker.fetch(`http://fixture/workflow?id=${entry.command.id}&action=restart`, {
        method: "POST",
      });
      await completed(entry.command.id);
      expect(patches).toBe(prepared);
      expect(createdDatabases.size).toBe(2);
      expect(buckets.size).toBe(2);
      expect(await (await authenticatedFetch(`https://${first.hostname}/`)).text()).toBe(
        "third version",
      );
    }, 40_000);
    it("does not let an explicitly restarted older deployment overwrite newer code", async () => {
      const before = await host(first.hostname);
      await worker.fetch(`http://fixture/workflow?id=${rejected.command.id}&action=restart`, {
        method: "POST",
      });
      await expect
        .poll(() => nativeStatus(rejected.command.id), { timeout: 30_000, interval: 100 })
        .toBe("errored");
      expect(await host(first.hostname)).toEqual(before);
      expect(await (await authenticatedFetch(`https://${first.hostname}/`)).text()).toBe(
        "third version",
      );
    }, 40_000);
    it("preserves a completed deployment when only its final history write needs recovery", async () => {
      await dispatch(first);
      await completed(first.command.id);

      const newer = await seedDeployment(environment.database.db, {
        appId: first.appId,
        source: deploymentSource.replace("deployed fixture", "latest complete version"),
      });

      await seed(newer);
      await dispatch(newer);
      await completed(newer.command.id);
      const active = await host(first.hostname);
      await environment.database.db
        .update(cloudflareOperations)
        .set({ error: "Fixture lost completion" })
        .where(eq(cloudflareOperations.id, first.command.id));
      await worker.fetch(`http://fixture/workflow?id=${first.command.id}&action=restart`, {
        method: "POST",
      });
      await completed(first.command.id);

      const [record] = await environment.database.db
        .select()
        .from(deployments)
        .where(eq(deployments.id, first.command.id));

      expect(record?.status).toBe("succeeded");
      expect(await host(first.hostname)).toEqual(active);
    }, 30_000);
    it("retains an unconfirmed binding write after native failure and process restart", async () => {
      const before = bindingRequests;
      bindingMode = "delayed";
      await dispatch(delayed, "fast-retries");
      await expect
        .poll(() => nativeStatus(delayed.command.id), { timeout: 30_000, interval: 100 })
        .toBe("errored");
      expect(bindingRequests).toBe(before + 1);
      expect((await operation(delayed.command.id))?.error).toContain("resource update");

      const [record] = await environment.database.db
        .select()
        .from(deployments)
        .where(eq(deployments.id, delayed.command.id));

      expect(record?.message).toContain("unconfirmed");
      const [pending] = await environment.database.db.select().from(cloudflareRuntimeBindings);
      expect(
        z.object({ bindings: z.array(z.string()) }).parse(pending?.pending).bindings,
      ).toContain(`B_${resourceName(delayed.appId, "d1", "data")}`);
      expect(await host(delayed.hostname)).toBeNull();

      const codeOnly = await seedDeployment(environment.database.db, { appId: first.appId });
      await seed(codeOnly);
      await dispatch(codeOnly);
      await completed(codeOnly.command.id);
      expect(bindingRequests).toBe(before + 1);
      expect((await authenticatedFetch(`https://${first.hostname}/resources`)).status).toBe(200);
      await worker.stop();
      worker = await start();

      if (!delayedBindingUpdate) throw new Error("Missing delayed settings write");
      delayedBindingUpdate();
      delayedBindingUpdate = undefined;
      await worker.fetch(`http://fixture/workflow?id=${delayed.command.id}&action=restart`, {
        method: "POST",
      });
      await completed(delayed.command.id);
      expect(bindingRequests).toBe(before + 1);
      expect((await authenticatedFetch(`https://${delayed.hostname}/resources`)).status).toBe(200);
      const [reconciled] = await environment.database.db.select().from(cloudflareRuntimeBindings);
      expect(reconciled?.pending).toBeNull();
    }, 90_000);

    it("automatically confirms an applied binding update after a lost acknowledgement", async () => {
      const before = bindingRequests;
      bindingMode = "lost-response";
      await dispatch(lostResponse);
      await completed(lostResponse.command.id);
      expect(bindingRequests).toBe(before + 1);
      expect((await authenticatedFetch(`https://${lostResponse.hostname}/resources`)).status).toBe(
        200,
      );
      const [record] = await environment.database.db.select().from(cloudflareRuntimeBindings);
      expect(record?.pending).toBeNull();
    }, 60_000);

    const manage = async (
      entry: typeof first,
      kind: "migrations" | "workflows",
      request: z.infer<typeof contract.migrationRequest> | z.infer<typeof contract.workflowRequest>,
      id: string = crypto.randomUUID(),
    ) => {
      const input = { appId: entry.appId, kind, request, id };

      const submit = await worker.fetch("http://fixture/operation", {
        method: "POST",
        body: JSON.stringify(input),
      });

      expect(submit.status, await submit.clone().text()).toBe(200);

      let result:
        | z.infer<typeof contract.workflowOperation>
        | z.infer<typeof contract.migrationOperation>
        | undefined;

      await expect
        .poll(
          async () => {
            const response = await worker.fetch("http://fixture/operation", {
              method: "POST",
              body: JSON.stringify({ ...input, read: true }),
            });

            const body = await response.json();
            result =
              kind === "migrations"
                ? contract.migrationOperation.parse(body)
                : contract.workflowOperation.parse(body);

            return result.state;
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe("succeeded");

      if (!result) throw new Error("Missing operation result");

      return result;
    };

    it("applies and lists D1 migrations through the existing management service with isolated preview history", async () => {
      const input = contract.migrationRequest.parse({
        action: "apply",
        database: "DB",
        databaseId: "data",
        table: "d1_migrations",
        files: [
          {
            name: "1_create.sql",
            sql: "CREATE TABLE migrated(value TEXT); INSERT INTO migrated VALUES ('once');",
          },
        ],
      });

      const id = crypto.randomUUID();
      appliedMigration = { id, request: input };
      expect(await manage(first, "migrations", input, id)).toMatchObject({
        entries: [{ name: "1_create.sql", applied: true }],
      });
      expect(await manage(first, "migrations", input, id)).toMatchObject({
        entries: [{ name: "1_create.sql", applied: true }],
      });

      const retained = await worker.fetch("http://fixture/operation", {
        method: "POST",
        body: JSON.stringify({
          appId: first.appId,
          kind: "migrations",
          request: input,
          id,
          expired: true,
        }),
      });

      expect(retained.status).toBe(200);
      expect(await retained.json()).toMatchObject({
        state: "succeeded",
        entries: [{ name: "1_create.sql", applied: true }],
      });

      const listing = contract.migrationRequest.parse({
        ...input,
        action: "list",
        files: [{ name: "1_create.sql" }],
      });

      expect(await manage(preview, "migrations", listing)).toMatchObject({
        entries: [{ name: "1_create.sql", applied: false }],
      });
      const physicalId = databases.get(resourceName(first.appId, "d1", "data"));
      expect(
        migrations
          .get(physicalId ?? "")
          ?.prepare("SELECT count(*) AS count FROM migrated")
          .get(),
      ).toEqual({ count: 1 });

      for (const changes of [
        { actor: "stranger" },
        { request: { ...input, databaseId: "foreign" } },
        { appId: preview.appId, read: true },
      ]) {
        const denied = await worker.fetch("http://fixture/operation", {
          method: "POST",
          body: JSON.stringify({
            kind: "migrations",
            appId: first.appId,
            id,
            request: input,
            ...changes,
          }),
        });

        expect(denied.status).toBe(400);
      }

      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    }, 60_000);

    const capabilityBindings = contract.workerMetadata.parse({
      main_module: "app.js",
      compatibility_date: "2026-10-01",
      assets: { upload_session: crypto.randomUUID() },
      bindings: [
        { type: "kv_namespace", name: "KV", id: "cache" },
        { type: "queue", name: "JOBS", queue: "jobs" },
        {
          type: "workflow",
          name: "WORKFLOW",
          workflow_name: "example",
          class_name: "ExampleWorkflow",
        },
      ],
    }).bindings;

    const appJson = async (
      entry: typeof first,
      path: string,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
      const response = await authenticatedFetch(`https://${entry.hostname}${path}`, init);
      expect(response.status, await response.clone().text()).toBe(200);

      return z.json().parse(await response.json());
    };

    it("provisions KV, Queues, Cron and app Workflows together and isolates production from previews", async () => {
      for (const entry of [first, preview]) {
        const next = await seedDeployment(environment.database.db, {
          appId: entry.appId,
          source: capabilitiesSource,
          bindings: capabilityBindings,
          crons: ["*/5 * * * *"],
          consumers: [
            {
              queue: "jobs",
              max_batch_size: 1,
              max_batch_timeout: 1,
              max_retries: 2,
              dead_letter_queue: "failed",
            },
          ],
        });

        await seed(next);
        await dispatch(next);
        await completed(next.command.id);
      }

      expect(namespaces.size).toBe(2);
      expect(queues.size).toBe(4);
      expect(schedules).toEqual([{ cron: "*/5 * * * *" }]);

      for (const entry of [first, preview]) {
        const queue = queues.get(resourceName(entry.appId, "queue", "jobs"));
        expect(queue?.consumers).toMatchObject([
          {
            script: "fixture-runtime",
            settings: { batch_size: 1, max_wait_time_ms: 1000, max_retries: 2 },
            dead_letter_queue: resourceName(entry.appId, "queue", "failed"),
          },
        ]);
        expect(settings.get(`B_${resourceName(entry.appId, "kv", "cache")}`)).toMatchObject({
          type: "kv_namespace",
        });
        expect(settings.get(`B_${resourceName(entry.appId, "queue", "jobs")}`)).toMatchObject({
          type: "queue",
        });
      }

      await appJson(first, "/kv", { method: "PUT", body: "production" });
      expect(await appJson(first, "/kv")).toBe("production");
      expect(await appJson(preview, "/kv")).toBeNull();
      await appJson(first, "/queue", { method: "POST", body: "message" });
      await expect.poll(() => appJson(first, "/queue"), { timeout: 15_000 }).toBe("jobs:message");
      expect(await appJson(preview, "/queue")).toBeNull();
      expect(
        (await worker.fetch("http://fixture/cron?cron=" + encodeURIComponent("*/5 * * * *")))
          .status,
      ).toBe(204);

      for (const entry of [first, preview])
        expect(await appJson(entry, "/cron")).toBe("*/5 * * * *");
    }, 100_000);

    it("manages native app Workflows through the existing service and preserves request identity", async () => {
      const create = contract.workflowRequest.parse({
        action: "create",
        workflow: "example",
        id: "same-id",
        params: { wait: true, zz: 1, a: { longer: 1, b: 2 } },
      });

      if (create.action !== "create") throw new Error("Fixture requires a create operation");
      const id = crypto.randomUUID();
      expect(await manage(first, "workflows", create, id)).toMatchObject({
        result: { id: "same-id" },
      });
      expect(
        await manage(
          first,
          "workflows",
          { ...create, params: { a: { b: 2, longer: 1 }, zz: 1, wait: true } },
          id,
        ),
      ).toMatchObject({
        result: { id: "same-id" },
      });
      expect(await manage(preview, "workflows", create)).toMatchObject({
        result: { id: "same-id" },
      });

      for (const action of ["pause", "resume"] as const)
        expect(
          await manage(first, "workflows", { action, workflow: "example", id: "same-id" }),
        ).toMatchObject({ result: null });
      await manage(first, "workflows", {
        action: "sendEvent",
        workflow: "example",
        id: "same-id",
        event: { type: "continue", payload: { zz: 1, a: { longer: 1, b: 2 } } },
      });
      await expect
        .poll(
          async () =>
            await manage(first, "workflows", {
              action: "status",
              workflow: "example",
              id: "same-id",
            }),
          { timeout: 30_000 },
        )
        .toMatchObject({ result: { status: "complete", output: 42 } });
      expect(
        await manage(preview, "workflows", { action: "list", workflow: "example" }),
      ).toMatchObject({ result: { instances: [{ id: "same-id" }] } });
      await manage(preview, "workflows", {
        action: "terminate",
        workflow: "example",
        id: "same-id",
      });
      await manage(preview, "workflows", { action: "delete", workflow: "example", id: "same-id" });
      expect(
        await manage(preview, "workflows", { action: "list", workflow: "example" }),
      ).toMatchObject({ result: { instances: [] } });

      const denied = await worker.fetch("http://fixture/operation", {
        method: "POST",
        body: JSON.stringify({
          kind: "workflows",
          appId: first.appId,
          id,
          request: { ...create, id: "different" },
        }),
      });

      expect(denied.status).toBe(400);
      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    }, 100_000);

    it("updates and removes event subscriptions without changing another app", async () => {
      const next = await seedDeployment(environment.database.db, {
        appId: first.appId,
        source: capabilitiesSource,
        bindings: capabilityBindings,
        crons: ["10 * * * *"],
        consumers: [],
      });

      await seed(next);
      await dispatch(next);
      await completed(next.command.id);
      expect(schedules).toEqual([{ cron: "*/5 * * * *" }, { cron: "10 * * * *" }]);
      expect(queues.get(resourceName(first.appId, "queue", "jobs"))?.consumers).toEqual([]);
      expect(queues.get(resourceName(preview.appId, "queue", "jobs"))?.consumers).toHaveLength(1);
      await worker.fetch("http://fixture/cron?cron=" + encodeURIComponent("10 * * * *"));
      expect(await appJson(first, "/cron")).toBe("10 * * * *");
      await worker.fetch("http://fixture/cron?cron=" + encodeURIComponent("*/5 * * * *"));
      expect(await appJson(first, "/cron")).toBe("10 * * * *");

      const rollback = await seedDeployment(environment.database.db, {
        appId: first.appId,
        source: capabilitiesSource,
        bindings: capabilityBindings,
        crons: ["*/5 * * * *"],
        consumers: [{ queue: "jobs" }],
      });

      await seed(rollback);
      await dispatch(rollback);
      await completed(rollback.command.id);
      expect(schedules).toEqual([{ cron: "*/5 * * * *" }]);
      expect(queues.get(resourceName(first.appId, "queue", "jobs"))?.consumers).toMatchObject([
        { settings: { batch_size: 10, max_wait_time_ms: 5000 } },
      ]);
    }, 60_000);
    it("recovers an unacknowledged schedule update without sending it twice", async () => {
      const before = scheduleWrites;

      const entry = await seedDeployment(environment.database.db, {
        appId: first.appId,
        source: capabilitiesSource,
        bindings: capabilityBindings,
        crons: ["10 * * * *"],
        consumers: [{ queue: "jobs" }],
      });

      scheduleMode = "lost-response";
      await seed(entry);
      await dispatch(entry, "fast-retries");
      await completed(entry.command.id);
      // Staging adds the new cron; publication removes the old app's cron only if no other app uses it.
      expect(scheduleWrites - before).toBe(1);
      expect(schedules).toEqual([{ cron: "*/5 * * * *" }, { cron: "10 * * * *" }]);
    }, 30_000);

    it("retains uncertain schedules until confirmed and removes staged routes on a later code-only deployment", async () => {
      const before = scheduleWrites;

      const entry = await seedDeployment(environment.database.db, {
        appId: lostResponse.appId,
        crons: ["20 * * * *"],
      });

      scheduleMode = "delayed";
      await seed(entry);
      await dispatch(entry, "fast-retries");
      await expect.poll(() => nativeStatus(entry.command.id), { timeout: 30_000 }).toBe("errored");
      expect((await operation(entry.command.id))?.error).toContain("unconfirmed");
      expect(scheduleWrites).toBe(before + 1);

      if (!delayedSchedule) throw new Error("Missing delayed schedule");
      delayedSchedule();
      delayedSchedule = undefined;
      const codeOnly = await seedDeployment(environment.database.db, { appId: lostResponse.appId });
      await seed(codeOnly);
      await dispatch(codeOnly);
      await completed(codeOnly.command.id);
      expect(schedules).toEqual([{ cron: "*/5 * * * *" }, { cron: "10 * * * *" }]);
      expect(scheduleWrites).toBe(before + 2);
    }, 45_000);
    it("returns large app Workflow outputs without re-encoding them into management checkpoints", async () => {
      await manage(first, "workflows", {
        action: "create",
        workflow: "example",
        id: "large-output",
        params: { large: true },
      });
      await expect
        .poll(
          async () => {
            const operation = await manage(first, "workflows", {
              action: "status",
              workflow: "example",
              id: "large-output",
            });

            const result = contract.workflowOperation.parse(operation).result;

            return z.object({ output: z.string().optional() }).parse(result).output?.length;
          },
          { timeout: 20_000 },
        )
        .toBe(300000);
    }, 30_000);

    it("does not overwrite another command's receipt when native operation registration rejects an ID collision", async () => {
      const before = await operation(first.command.id);
      expect(
        (
          await worker.fetch("http://fixture/raw-operation", {
            method: "POST",
            body: JSON.stringify({
              id: first.command.id,
              appId: preview.appId,
              createdAt: new Date().toISOString(),
              actor: { id: "fixture-owner", admin: false, application: environment.application },
              kind: "workflows",
              request: { action: "list", workflow: "example" },
            }),
          })
        ).status,
      ).toBe(204);
      await expect
        .poll(
          async () => {
            const response = await worker.fetch(
              `http://fixture/workflow?app-operation=1&id=${first.command.id}`,
            );

            return z.object({ status: z.string() }).parse(await response.json()).status;
          },
          { timeout: 15_000 },
        )
        .toBe("errored");
      expect(await operation(first.command.id)).toEqual(before);
    }, 20_000);
    it("delivers a shared cron to more than four distinct Dynamic Workers", async () => {
      for (let index = 0; index < 6; index++) {
        const entry = await seedDeployment(environment.database.db, {
          source: "export default {fetch(){return new Response('cron fixture');},scheduled(){}};",
          bindings: [],
          crons: ["30 * * * *"],
        });

        await seed(entry);
        await dispatch(entry);
        await completed(entry.command.id);
      }

      const response = await worker.fetch(
        "http://fixture/cron?cron=" + encodeURIComponent("30 * * * *"),
      );

      expect(response.status, await response.clone().text()).toBe(204);
    }, 30_000);
    it("returns accepted migration history after the deployed D1 binding is removed", async () => {
      if (!appliedMigration) throw new Error("Migration fixture missing");
      expect(
        await manage(first, "migrations", appliedMigration.request, appliedMigration.id),
      ).toMatchObject({ entries: [{ name: "1_create.sql", applied: true }] });
      await environment.database.db
        .update(apps)
        .set({ state: "deleting" })
        .where(eq(apps.id, first.appId));

      try {
        expect(
          await manage(first, "migrations", appliedMigration.request, appliedMigration.id),
        ).toMatchObject({ state: "succeeded" });
      } finally {
        await environment.database.db
          .update(apps)
          .set({ state: "active" })
          .where(eq(apps.id, first.appId));
      }
    }, 20_000);

    it("preserves actionable Workflow validation errors in operation history", async () => {
      const id = crypto.randomUUID();

      const input = {
        id,
        appId: first.appId,
        kind: "workflows",
        request: { action: "status", workflow: "example", id: "missing-instance" },
      };

      expect(
        (
          await worker.fetch("http://fixture/operation", {
            method: "POST",
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(200);
      await expect
        .poll(
          async () => {
            const response = await worker.fetch("http://fixture/operation", {
              method: "POST",
              body: JSON.stringify({ ...input, read: true }),
            });

            return contract.workflowOperation.parse(await response.json()).message;
          },
          { timeout: 15_000 },
        )
        .toContain("Workflow instance not found");
    }, 20_000);

    it("removes explicitly rejected cron stages so corrected and unrelated deployments can proceed", async () => {
      const before = await host(lostResponse.hostname);

      const rejected = await seedDeployment(environment.database.db, {
        appId: lostResponse.appId,
        crons: ["61 * * * *"],
      });

      await seed(rejected);
      await dispatch(rejected, "fast-retries");
      await expect
        .poll(() => nativeStatus(rejected.command.id), { timeout: 15_000 })
        .toBe("errored");
      expect(await host(lostResponse.hostname)).toEqual(before);

      const unrelated = await seedDeployment(environment.database.db, {
        source: "export default {fetch(){return new Response('valid');},scheduled(){}};",
        bindings: [],
        crons: ["40 * * * *"],
      });

      await seed(unrelated);
      await dispatch(unrelated);
      await completed(unrelated.command.id);

      const corrected = await seedDeployment(environment.database.db, {
        appId: lostResponse.appId,
        crons: ["50 * * * *"],
      });

      await seed(corrected);
      await dispatch(corrected);
      await completed(corrected.command.id);
      expect(schedules).toContainEqual({ cron: "40 * * * *" });
      expect(schedules).toContainEqual({ cron: "50 * * * *" });
      expect(schedules).not.toContainEqual({ cron: "61 * * * *" });
    }, 30_000);
    it("deploys approved connector RPC bindings and applies replacement and revocation through the same workflow", async () => {
      const reference = connectorReference.parse({
        name: "app-connector",
        checksum: "a".repeat(64),
        entrypoints: ["default", "Reader"],
        classes: [],
      });

      await environment.database.db.insert(connectors).values({
        organizationId: first.organizationId,
        name: reference.name,
        package: reference,
        appliedPackage: reference,
        jobId: crypto.randomUUID(),
      });

      const entry = await seedDeployment(environment.database.db, {
        bindings: [],
        source: `export default {async fetch(request, env) {return Response.json({value: env.ERP ? await env.ERP.read() : null, secret: env.WIDEFLEET_SECRET_API_KEY ?? null});}}`,
      });

      const bind = (grant: z.infer<typeof contract.capabilityGrant> | null) =>
        bindConnector(entry.appId, "ERP", grant);

      await bind({ connector: reference.name, entrypoint: "default" });
      await seed(entry);
      await dispatch(entry);
      await completed(entry.command.id);
      expect(await (await authenticatedFetch(`https://${entry.hostname}/`)).json()).toEqual({
        value: "default-connector",
        secret: null,
      });
      await bind({ connector: reference.name, entrypoint: "Reader" });
      expect(await (await authenticatedFetch(`https://${entry.hostname}/`)).json()).toEqual({
        value: "named-connector",
        secret: null,
      });
      expect(
        await (await worker.fetch(`http://fixture/connections?appId=${entry.appId}`)).json(),
      ).toMatchObject({
        connectors: { state: "active" },
        activeConnectors: { ERP: { connector: reference.name, entrypoint: "Reader" } },
      });
      await bind(null);
      expect(await (await authenticatedFetch(`https://${entry.hostname}/`)).json()).toEqual({
        value: null,
        secret: null,
      });
      expect(
        await (await worker.fetch(`http://fixture/connections?appId=${entry.appId}`)).json(),
      ).toMatchObject({ connectors: { state: "active" }, activeConnectors: {} });
      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    }, 60_000);

    it.each(["saved", "failed", "unconfirmed", "legacy"])(
      "confirms saved revocations only without a possible publication: %s",
      async (state) => {
        const reference = connectorReference.parse({
          name: `saved-${state}`,
          checksum: "b".repeat(64),
          entrypoints: ["default", "Reader"],
          classes: [],
        });

        await environment.database.db.insert(connectors).values({
          organizationId: first.organizationId,
          name: reference.name,
          package: reference,
          appliedPackage: reference,
          jobId: crypto.randomUUID(),
        });

        const entry = await seedDeployment(environment.database.db, {
          bindings: [],
          source: "export default { fetch: invalid syntax };",
        });

        await bindConnector(entry.appId, "ERP", {
          connector: reference.name,
          entrypoint: "Reader",
        });
        await bindConnector(entry.appId, "OTHER", {
          connector: reference.name,
          entrypoint: "default",
        });

        if (state !== "saved") {
          await seed(entry);
          await dispatch(entry, "fast-retries");
          await expect
            .poll(() => nativeStatus(entry.command.id), { timeout: 30_000 })
            .toBe("errored");
          const history = await operation(entry.command.id);
          expect(history?.targets).toEqual([
            expect.objectContaining({ publicationStarted: false }),
          ]);

          if (state === "unconfirmed" || state === "legacy") {
            const targets = z.array(z.record(z.string(), z.json())).parse(history?.targets);

            for (const target of targets) {
              if (state === "legacy") delete target["publicationStarted"];
              else target["publicationStarted"] = true;
            }

            await environment.database.db
              .update(cloudflareOperations)
              .set({ targets })
              .where(eq(cloudflareOperations.id, entry.command.id));
          }
        }

        await bindConnector(entry.appId, "ERP", null);
        expect(await host(entry.hostname)).toBeNull();
        const replacement = connectorFixture(reference.name);
        replacement.metadata.entrypoints = ["default"];

        const prepare = () =>
          worker.fetch("http://fixture/prepare-connector", {
            method: "POST",
            body: JSON.stringify({ organizationId: entry.organizationId, release: replacement }),
          });

        const safe = state === "saved" || state === "failed";
        const prepared = await prepare();
        expect(prepared.status, await prepared.text()).toBe(safe ? 204 : 400);

        await bindConnector(entry.appId, "OTHER", null);
        expect((await prepare()).status).toBe(safe ? 204 : 400);

        const [app] = await environment.database.db
          .select()
          .from(apps)
          .where(eq(apps.id, entry.appId));

        expect(app?.appliedCapabilityRevision).toBe(safe ? 4 : 2);
      },
      60_000,
    );

    const remove = (appId: string, options: { actor?: string; unavailable?: boolean } = {}) =>
      worker.fetch("http://fixture/remove", {
        method: "POST",
        body: JSON.stringify({
          appId,
          id: cloudflareRemovalId(appId, options.actor ?? "fixture-owner"),
          ...options,
        }),
      });

    const removed = async (appId: string) => {
      const id = cloudflareRemovalId(appId, "fixture-owner");
      await expect
        .poll(
          async () => {
            const response = await worker.fetch(`http://fixture/workflow?app-operation&id=${id}`);

            return z.object({ status: z.string() }).parse(await response.json()).status;
          },
          { timeout: 60000, interval: 100 },
        )
        .toBe("complete");
      expect(
        await environment.database.db.select().from(apps).where(eq(apps.id, appId)),
      ).toHaveLength(0);
    };

    it("authorizes removal before admission and leaves an app active when native admission fails", async () => {
      const entry = await seedDeployment(environment.database.db, { bindings: [] });
      expect((await remove(entry.appId, { actor: "stranger" })).status).toBe(400);
      expect((await remove(entry.appId, { unavailable: true })).status).toBe(400);

      const [record] = await environment.database.db
        .select()
        .from(apps)
        .where(eq(apps.id, entry.appId));

      expect(record?.state).toBe("created");
      expect(await operation(cloudflareRemovalId(entry.appId, "fixture-owner"))).toBeUndefined();
      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    });

    it("lets the owner delete after a failed admission from a now-revoked grantee", async () => {
      const entry = await seedDeployment(environment.database.db, { bindings: [] });
      const grantee = "removal-grantee";
      await environment.database.db
        .insert(user)
        .values({ id: grantee, name: "Removal fixture", email: "removal-grantee@example.test" });
      await environment.database.db
        .insert(appGrants)
        .values({ appId: entry.appId, userId: grantee });
      expect((await remove(entry.appId, { actor: grantee, unavailable: true })).status).toBe(400);
      await environment.database.db.delete(appGrants).where(eq(appGrants.appId, entry.appId));
      expect((await remove(entry.appId, { actor: grantee })).status).toBe(400);
      expect((await remove(entry.appId)).status).toBe(200);
      await removed(entry.appId);
    }, 60000);

    it.each(["absent", "created"])(
      "removes an app after exhausted creation retries with its resource %s",
      async (outcome) => {
        const entry = await seedDeployment(environment.database.db, {
          bindings: [{ type: "d1", name: "DB", database_name: "late" }],
        });

        heldDatabaseName = resourceName(entry.appId, "d1", "late");
        databases.set(heldDatabaseName, crypto.randomUUID());
        await seed(entry);

        const before = databaseCreates;
        await dispatch(entry, "fast-retries");
        await expect.poll(() => nativeStatus(entry.command.id), { timeout: 30000 }).toBe("errored");
        expect(databaseCreates - before).toBe(6);
        expect((await operation(entry.command.id))?.error).toBeTruthy();

        if (outcome === "created") {
          if (!finishDatabaseCreation) throw new Error("Missing delayed CREATE");
          finishDatabaseCreation();
        }

        heldDatabaseName = "";
        finishDatabaseCreation = undefined;
        await worker.stop();
        worker = await start();
        expect((await remove(entry.appId)).status).toBe(200);
        await removed(entry.appId);
        expect(databaseCreates - before).toBe(6);
        expect(createdDatabases.has(resourceName(entry.appId, "d1", "late"))).toBe(false);
      },
      90000,
    );

    it("cleans historical resources beyond the first metadata page", async () => {
      const entry = await seedDeployment(environment.database.db, { bindings: [] });
      const historical = resourceName(entry.appId, "r2", "historical-files");
      buckets.add(historical);

      for (let page = 0; page < 3; page++) {
        await environment.database.db.insert(artifacts).values(
          Array.from({ length: 100 }, (_, index) => ({
            ...entry.artifact,
            id: `ffffffff-ffff-4fff-8fff-${String(page * 100 + index).padStart(12, "0")}`,
            metadata: {
              ...entry.artifact.metadata,
              bindings:
                page === 2
                  ? [{ type: "r2_bucket", name: "OLD", bucket_name: "historical-files" }]
                  : [],
            },
          })),
        );
      }

      expect((await remove(entry.appId)).status).toBe(200);
      await removed(entry.appId);
      expect(buckets.has(historical)).toBe(false);
    }, 60000);

    it("removes an undeployed app and its nested previews, including stored uploads", async () => {
      const root = await seedDeployment(environment.database.db, { bindings: [] });
      const child = await seedDeployment(environment.database.db, { bindings: [] });
      const grandchild = await seedDeployment(environment.database.db, { bindings: [] });
      await environment.database.db
        .update(apps)
        .set({ parentId: root.appId })
        .where(eq(apps.id, child.appId));
      await environment.database.db
        .update(apps)
        .set({ parentId: child.appId })
        .where(eq(apps.id, grandchild.appId));

      for (const entry of [root, child, grandchild]) await seed(entry);
      expect((await remove(root.appId)).status).toBe(200);
      await removed(root.appId);

      for (const entry of [root, child, grandchild]) {
        expect(
          await environment.database.db.select().from(apps).where(eq(apps.id, entry.appId)),
        ).toHaveLength(0);
        expect((await host(entry.hostname))?.body).toEqual({ deleted: true, appId: entry.appId });
        const stored = await worker.fetch(`http://fixture/storage?prefix=apps/${entry.appId}/`);
        expect(await stored.json()).toEqual([]);
        expect((await authenticatedFetch(`https://${entry.hostname}/`)).status).toBe(404);
      }
    }, 60000);

    it("deletes a deployed preview and its workflow, history and resources while preserving its parent", async () => {
      const published = contract.publishedApp.parse((await host(preview.hostname))?.body);
      await manage(preview, "workflows", {
        action: "create",
        workflow: "example",
        id: "remove-running",
        params: { wait: true },
      });

      const oldResources = [
        ["d1", "data"],
        ["r2", "files"],
        ["kv", "cache"],
        ["queue", "jobs"],
        ["queue", "failed"],
      ] as const;

      const bucket = resourceName(preview.appId, "r2", "files");
      bucketObjects.set(bucket, new Set(Array.from({ length: 105 }, (_, i) => `folder/${i}?file`)));
      failedObjectDelete = true;

      const parentVersion = await seedDeployment(environment.database.db, {
        appId: first.appId,
        bindings: [],
      });

      await seed(parentVersion);
      await dispatch(parentVersion);
      await completed(parentVersion.command.id);
      const parentHost = await host(first.hostname);

      const sharedBindings = [...settings.keys()].filter(
        (name) =>
          !oldResources.some(
            ([kind, key]) => name === `B_${resourceName(preview.appId, kind, key)}`,
          ),
      );

      const response = await remove(preview.appId);
      expect(response.status, await response.text()).toBe(200);
      await removed(preview.appId);
      expect((await host(preview.hostname))?.body).toEqual({ deleted: true, appId: preview.appId });
      expect(await host(first.hostname)).toEqual(parentHost);
      expect((await authenticatedFetch(`https://${preview.hostname}/`)).status).toBe(404);
      expect((await authenticatedFetch(`https://${first.hostname}/`)).status).toBe(200);

      for (const [kind, key] of oldResources) {
        const name = resourceName(preview.appId, kind, key);
        expect(settings.has(`B_${name}`)).toBe(false);
        expect(
          createdDatabases.has(name) ||
            buckets.has(name) ||
            namespaces.has(name) ||
            queues.has(name),
        ).toBe(false);
      }

      for (const name of sharedBindings) expect(settings.has(name)).toBe(true);
      expect(deletedResources).toContain(bucket);
      expect(bucketObjects.get(bucket)?.size).toBe(0);
      expect(
        await environment.database.db
          .select()
          .from(artifacts)
          .where(eq(artifacts.appId, preview.appId)),
      ).toHaveLength(0);

      for (const prefix of ["apps", "versions", "access", "workflow-versions"]) {
        const response = await worker.fetch(
          `http://fixture/storage?prefix=${prefix}/${preview.appId}/`,
        );

        expect(await response.json()).toEqual([]);
      }

      const catalog = await managementFetch(
        `https://${preview.hostname}/.well-known/widefleet/workflows`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            appId: preview.appId,
            hostname: preview.hostname,
            requestId: crypto.randomUUID(),
            request: { action: "list", workflow: "example" },
          }),
        },
      );

      expect(catalog.status).toBe(400);

      const stale = await worker.fetch("http://fixture/stale-stage", {
        method: "POST",
        body: JSON.stringify({ app: published, id: crypto.randomUUID(), sequence: 99999 }),
      });

      expect(stale.status).toBe(409);

      const provision = await worker.fetch("http://fixture/stale-provision", {
        method: "POST",
        body: JSON.stringify(preview.command),
      });

      expect(provision.status).toBe(409);

      const publication = await worker.fetch("http://fixture/stale-publication", {
        method: "POST",
        body: JSON.stringify({ hostname: preview.hostname, app: published }),
      });

      expect(await publication.json()).toEqual({ written: false });
    }, 60000);

    it("resumes a failed removal only after an explicit native restart without recreating resources", async () => {
      deniedBucket = resourceName(delayed.appId, "r2", "files");
      expect((await remove(delayed.appId)).status).toBe(200);
      const id = cloudflareRemovalId(delayed.appId, "fixture-owner");
      await expect
        .poll(
          async () => {
            const response = await worker.fetch(`http://fixture/workflow?app-operation&id=${id}`);

            return z.object({ status: z.string() }).parse(await response.json()).status;
          },
          { timeout: 30000 },
        )
        .toBe("errored");

      const [record] = await environment.database.db
        .select()
        .from(apps)
        .where(eq(apps.id, delayed.appId));

      expect(record?.state).toBe("deleting");
      expect((await operation(id))?.error).toBe("Cloudflare could not complete app removal");
      expect((await authenticatedFetch(`https://${delayed.hostname}/`)).status).toBe(404);
      deniedBucket = "";
      const commandKey = `apps/${delayed.appId}/commands/${id}.json`;
      expect(
        (await worker.fetch(`http://fixture/storage?key=${commandKey}`, { method: "DELETE" }))
          .status,
      ).toBe(204);
      expect((await remove(delayed.appId, { unavailable: true })).status).toBe(200);

      const commands = await worker.fetch(`http://fixture/storage?prefix=${commandKey}`);

      expect(await commands.json()).toEqual([]);
      const stopped = await worker.fetch(`http://fixture/workflow?app-operation&id=${id}`);
      expect(z.object({ status: z.string() }).parse(await stopped.json()).status).toBe("errored");
      await worker.fetch(`http://fixture/workflow?app-operation&id=${id}&action=restart`, {
        method: "POST",
      });
      await removed(delayed.appId);
      expect(buckets.has(resourceName(delayed.appId, "r2", "files"))).toBe(false);
    }, 60000);

    it("removes an undeployed replacement whose hostname still contains the previous app's deletion fence", async () => {
      const replacement = await seedDeployment(environment.database.db, { bindings: [] });
      await environment.database.db
        .update(apps)
        .set({ hostname: preview.hostname })
        .where(eq(apps.id, replacement.appId));
      expect((await remove(replacement.appId)).status).toBe(200);
      await removed(replacement.appId);
      expect((await host(preview.hostname))?.body).toEqual({
        deleted: true,
        appId: replacement.appId,
      });
    }, 60000);

    it("allows a new app to claim a deleted hostname without reviving the old identity", async () => {
      const replacement = await seedDeployment(environment.database.db, {
        bindings: [],
        source: "export default {fetch(){return new Response('replacement')}}",
      });

      await environment.database.db
        .update(apps)
        .set({ hostname: preview.hostname })
        .where(eq(apps.id, replacement.appId));
      await seed(replacement);
      await dispatch(replacement);
      await completed(replacement.command.id);
      expect((await host(preview.hostname))?.body).toMatchObject({ appId: replacement.appId });
      expect(await (await authenticatedFetch(`https://${preview.hostname}/`)).text()).toBe(
        "replacement",
      );
    }, 60000);

    const runtimeRelease = (version: string) =>
      contract.runtimeRelease.parse({
        ...release,
        version,
        modules: release.modules.map((module) => {
          const source = module.source.replaceAll(
            `runtimeVersion: "${release.version}"`,
            `runtimeVersion: "${version}"`,
          );

          return { ...module, source, sha256: createHash("sha256").update(source).digest("hex") };
        }),
      });

    const selectRuntime = async (
      input: z.infer<typeof contract.runtimeRelease> | { version: string },
    ) => {
      // Wrangler forwards bodies as streams; retain the known length of the release.
      const payload = JSON.stringify(input);

      const response = await worker.fetch("http://fixture/runtime", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
        body: payload,
      });

      const body: unknown = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);

      return contract.runtimeStatus.parse(body);
    };

    const runtimeStatus = async () =>
      contract.runtimeStatus.parse(await (await worker.fetch("http://fixture/runtime")).json());

    it("updates and rolls back runtime code without rewriting app bindings or subscriptions", async () => {
      await selectRuntime(contract.runtimeRelease.parse(release));
      await expect
        .poll(runtimeStatus)
        .toMatchObject({ activeVersion: release.version, state: "succeeded" });

      const before = JSON.stringify({
        bindings: [...settings],
        schedules,
        queues: [...queues],
        bindingTag,
      });

      const next = runtimeRelease("99.1.0");
      const selected = await selectRuntime(next);
      expect(selected.desiredVersion).toBe(next.version);
      expect(selected.jobId).not.toBeNull();
      await expect
        .poll(runtimeStatus)
        .toMatchObject({ activeVersion: next.version, state: "succeeded" });
      expect(
        (await environment.database.db.select().from(organizationRuntimes))[0]?.appliedRuntime,
      ).toMatchObject({ version: next.version });
      expect(
        JSON.stringify({ bindings: [...settings], schedules, queues: [...queues], bindingTag }),
      ).toBe(before);
      expect(await environment.database.db.select().from(jobs)).toHaveLength(0);

      await selectRuntime({ version: release.version });
      await expect
        .poll(runtimeStatus)
        .toMatchObject({ activeVersion: release.version, state: "succeeded" });
      expect(
        JSON.stringify({ bindings: [...settings], schedules, queues: [...queues], bindingTag }),
      ).toBe(before);
      expect((await runtimeStatus()).versions).toContain(next.version);
    }, 20000);

    it("confirms a runtime upload with a lost response without uploading it again", async () => {
      const before = runtimeUploads;
      runtimeUploadMode = "lost-response";
      await selectRuntime(runtimeRelease("99.2.0"));
      await expect
        .poll(runtimeStatus, { timeout: 15000 })
        .toMatchObject({ activeVersion: "99.2.0", state: "succeeded" });
      expect(runtimeUploads).toBe(before + 1);
    }, 20000);

    it("reports a rejected runtime update and permits an explicit retry", async () => {
      const before = runtimeUploads;
      runtimeUploadMode = "rejected";
      const selected = await selectRuntime(runtimeRelease("99.3.0"));
      await expect.poll(runtimeStatus, { timeout: 15000 }).toMatchObject({
        activeVersion: "99.2.0",
        state: "failed",
        message: "Cloudflare rejected the runtime update (HTTP 400)",
      });
      expect(runtimeUploads).toBe(before + 1);
      runtimeUploadMode = "normal";
      const retried = await selectRuntime({ version: "99.3.0" });
      expect(retried.jobId).not.toBe(selected.jobId);
      await expect
        .poll(runtimeStatus, { timeout: 15000 })
        .toMatchObject({ activeVersion: "99.3.0", state: "succeeded" });
    }, 20000);

    it("does not replay an already completed runtime update after a native restart", async () => {
      const [previous] = await environment.database.db
        .select()
        .from(cloudflareOperations)
        .where(
          sql`${cloudflareOperations.command}->>'kind' = 'runtime' AND ${cloudflareOperations.command}->'runtime'->>'version' = '99.1.0'`,
        );

      if (!previous) throw new Error("Previous runtime update is missing");
      const before = runtimeUploads;
      await worker.fetch(`http://fixture/workflow?id=${previous.id}&action=restart`, {
        method: "POST",
      });
      await expect.poll(() => nativeStatus(previous.id)).toBe("complete");
      expect(runtimeVersion).toBe("99.3.0");
      expect(runtimeUploads).toBe(before);
    }, 20000);

    it("rejects runtime changes by nonadministrators, incompatible releases and unavailable rollback versions", async () => {
      const before = runtimeUploads;
      const unauthorized = await worker.fetch("http://fixture/runtime?nonadmin");
      expect(await unauthorized.json()).toEqual({ error: "Administrator permission is required" });
      expect(unauthorized.status).toBe(400);

      for (const [path, input, error] of [
        ["/runtime?nonadmin", runtimeRelease("99.4.0"), "Administrator permission is required"],
        [
          "/runtime",
          { ...runtimeRelease("99.4.0"), cloudflare: undefined },
          "This release does not support Cloudflare runtime protocol 1",
        ],
        ["/runtime", { version: "98.0.0" }, "This runtime version has not been installed"],
      ] as const) {
        const payload = JSON.stringify(input);

        const response = await worker.fetch(`http://fixture${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload)),
          },
          body: payload,
        });

        expect(await response.json()).toEqual({ error });
        expect(response.status).toBe(400);
      }

      expect(runtimeUploads).toBe(before);
      expect(await runtimeStatus()).toMatchObject({
        desiredVersion: "99.3.0",
        activeVersion: "99.3.0",
        state: "succeeded",
      });
    });

    it("uses the confirmed runtime for an app deployment accepted before a runtime rollback", async () => {
      const entry = await seedDeployment(environment.database.db, { bindings: [] });
      await seed(entry);
      await dispatch(entry, "register-only");
      expect((await operation(entry.command.id))?.targets).toMatchObject([
        { runtime: { version: "99.3.0" } },
      ]);
      await selectRuntime({ version: release.version });
      await expect
        .poll(runtimeStatus)
        .toMatchObject({ activeVersion: release.version, state: "succeeded" });
      await dispatch(entry);
      await completed(entry.command.id);
      expect((await host(entry.hostname))?.body).toMatchObject({ deploymentId: entry.command.id });

      const [failed] = await environment.database.db
        .select()
        .from(cloudflareOperations)
        .where(
          sql`${cloudflareOperations.command}->>'kind' = 'runtime' AND ${cloudflareOperations.error} IS NOT NULL`,
        );

      if (!failed) throw new Error("Failed runtime fixture is missing");
      const before = runtimeUploads;
      await worker.fetch(`http://fixture/workflow?id=${failed.id}&action=restart`, {
        method: "POST",
      });
      await expect
        .poll(async () => (await operation(failed.id))?.error)
        .toBe("A newer runtime update superseded this operation");
      expect(runtimeUploads).toBe(before);
      expect(runtimeVersion).toBe(release.version);
    }, 20000);

    it("rejects a delayed first registration after a newer runtime update completes", async () => {
      const [execution] = await environment.database.db.select().from(organizationRuntimes);

      if (!execution?.runtime) throw new Error("Runtime fixture is missing");

      const delayed = {
        kind: "runtime",
        id: crypto.randomUUID(),
        organizationId: execution.organizationId,
        previousJobId: execution.runtimeJobId,
        runtime: execution.runtime,
        actor: {
          id: "fixture-owner",
          admin: true,
          application: { ...environment.application, admin: true },
        },
        createdAt: new Date().toISOString(),
        rollback: true,
      };

      const newer = await selectRuntime({ version: "99.3.0" });
      await expect
        .poll(runtimeStatus)
        .toMatchObject({ activeVersion: "99.3.0", state: "succeeded" });
      const before = runtimeUploads;
      await worker.fetch("http://fixture/start?mode=accepted-only", {
        method: "POST",
        body: JSON.stringify(delayed),
      });
      await expect.poll(() => nativeStatus(delayed.id), { timeout: 15000 }).toBe("errored");
      expect(await runtimeStatus()).toMatchObject({
        jobId: newer.jobId,
        activeVersion: "99.3.0",
        state: "succeeded",
      });
      expect(runtimeUploads).toBe(before);
    }, 20000);

    it("rejects a delayed runtime command across infrastructure deployments and accepts a new update", async () => {
      const cloudflare = createCloudflareProvisioner(
        { accountId: "fixture", token: "fixture", runtimeName: "fixture" },
        async () =>
          Response.json({
            success: true,
            result: { bindings: [], annotations: { "workers/tag": bindingTag } },
          }),
      );

      const install = (version: string) =>
        deployHostedRuntime(
          environment.database.db,
          cloudflare,
          {
            put: async (key, bytes) => {
              const response = await worker.fetch(
                `http://fixture/storage?${new URLSearchParams({ key })}`,
                { method: "PUT", body: new TextDecoder().decode(bytes) },
              );

              expect(response.status).toBe(204);

              return Result.ok(undefined);
            },
          },
          runtimeRelease(version),
          async () => {
            runtimeVersion = version;
          },
        );

      await install("99.3.0");
      const [execution] = await environment.database.db.select().from(organizationRuntimes);

      if (!execution?.runtime) throw new Error("Runtime fixture is missing");

      const delayed = {
        kind: "runtime",
        id: crypto.randomUUID(),
        organizationId: execution.organizationId,
        previousJobId: execution.runtimeJobId,
        runtime: execution.runtime,
        actor: {
          id: "fixture-owner",
          admin: true,
          application: { ...environment.application, admin: true },
        },
        createdAt: new Date().toISOString(),
        rollback: true,
      };

      await install("99.4.0");
      const before = runtimeUploads;
      await worker.fetch("http://fixture/start?mode=accepted-only", {
        method: "POST",
        body: JSON.stringify(delayed),
      });
      await expect.poll(() => nativeStatus(delayed.id), { timeout: 15000 }).toBe("errored");
      expect(await runtimeStatus()).toMatchObject({
        jobId: null,
        desiredVersion: "99.4.0",
        activeVersion: "99.4.0",
        state: "succeeded",
      });
      expect(runtimeUploads).toBe(before);

      await selectRuntime({ version: "99.3.0" });
      await expect
        .poll(runtimeStatus)
        .toMatchObject({ activeVersion: "99.3.0", state: "succeeded" });
      expect(runtimeUploads).toBe(before + 1);
    }, 20000);

    it("deploys apps after runtime code changes but its confirmation fails", async () => {
      runtimeUploadMode = "unconfirmed";

      try {
        await selectRuntime(runtimeRelease("99.5.0"));
        await expect
          .poll(runtimeStatus, { timeout: 15000 })
          .toMatchObject({ state: "failed", activeVersion: null });
      } finally {
        runtimeVersionUnavailable = false;
        runtimeUploadMode = "normal";
      }

      expect(await runtimeStatus()).toMatchObject({ state: "failed", activeVersion: "99.5.0" });
      expect(
        (await environment.database.db.select().from(organizationRuntimes))[0]?.appliedRuntime,
      ).toMatchObject({ version: "99.3.0" });
      const entry = await seedDeployment(environment.database.db, { bindings: [] });
      await seed(entry);
      await dispatch(entry);
      await completed(entry.command.id);
      expect((await host(entry.hostname))?.body).toMatchObject({ deploymentId: entry.command.id });
    }, 20000);
  },
);
