import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Unstable_DevWorker } from "wrangler";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import release from "@platform/app-runtime/release" with { type: "json" };
import { createTestEnvironment } from "../environment.ts";
import { deploymentSource, seedDeployment } from "../cloudflare-deployment.fixture.ts";
import { initializeCloudflareFleet } from "../../src/lib/server/fleets.ts";
import { apps, deployments, jobs } from "../../src/lib/server/schema.ts";

const resourceName = (appId: string, kind: string, name: string) =>
  `r${createHash("sha256").update(`${appId}/${kind}/${name}`).digest("hex").slice(0, 40)}`;

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")(
  "Hosted deployment workflow in workerd",
  () => {
    let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
    let directory: string;
    let worker: Unstable_DevWorker;
    let first: Awaited<ReturnType<typeof seedDeployment>>;
    let preview: Awaited<ReturnType<typeof seedDeployment>>;
    const token = "local-deployment-runtime-token-never-deploy";
    const largeGroups = Array.from({ length: 100 }, (_, index) => `${index}-${"group".repeat(40)}`);
    const databases = new Map<string, string>();
    const createdDatabases = new Set<string>();
    const buckets = new Set<string>();
    let patches = 0;
    let apiOrigin = "";

    const api = createServer((request, response) => {
      const handle = async () => {
        const url = new URL(request.url ?? "/", apiOrigin);
        let body = "";

        for await (const chunk of request) body += String(chunk);

        const ok = (result: z.infer<ReturnType<typeof z.json>>) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ success: true, result }));
        };

        if (request.headers.authorization !== "Bearer local-provisioning-token")
          throw new Error("Incorrect API credential");

        if (url.pathname.endsWith("/d1/database")) {
          if (request.method === "GET") {
            ok([...createdDatabases].map((name) => ({ name, uuid: databases.get(name) ?? "" })));
          } else {
            const { name } = z.object({ name: z.string() }).parse(JSON.parse(body));

            if (!databases.has(name) || createdDatabases.has(name))
              throw new Error("Unexpected D1 creation");
            createdDatabases.add(name);
            ok({ name, uuid: databases.get(name) ?? "" });
          }
        } else if (url.pathname.endsWith("/r2/buckets")) {
          const { name } = z.object({ name: z.string() }).parse(JSON.parse(body));

          if (buckets.has(name)) throw new Error("Duplicate R2 creation");
          buckets.add(name);
          ok({ name });
        } else if (url.pathname.includes("/r2/buckets/")) {
          const name = url.pathname.split("/").at(-1) ?? "";

          if (buckets.has(name)) ok({ name });
          else {
            response.statusCode = 404;
            response.end();
          }
        } else if (url.pathname.endsWith("/settings")) {
          if (request.method === "PATCH") patches++;
          ok({
            bindings: [
              { name: "WIDEFLEET_PACKAGES", type: "r2_bucket" },
              { name: "WIDEFLEET_CONTROL_TOKEN", type: "secret_text" },
            ],
          });
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

    const seed = async (entry: typeof first) => {
      const response = await worker.fetch("http://fixture/seed", {
        method: "POST",
        body: JSON.stringify({ artifact: entry.artifact, source: entry.source }),
      });

      expect(response.status).toBe(204);
    };

    const dispatch = async () => {
      expect((await worker.fetch("http://fixture/start", { method: "POST" })).status).toBe(204);
    };

    const host = async (hostname: string) => {
      const response = await worker.fetch(`http://fixture/host?hostname=${hostname}`);

      return z
        .object({ body: z.unknown(), access: z.string().nullable() })
        .nullable()
        .parse(await response.json());
    };

    const jobState = async (id: string) => {
      const [job] = await environment.database.db.select().from(jobs).where(eq(jobs.id, id));

      return job;
    };

    const completed = async (id: string, state = "succeeded") => {
      await expect
        .poll(
          async () => {
            const response = await worker.fetch(`http://fixture/workflow?id=${id}`);

            const workflow = z
              .object({ status: z.string(), error: z.unknown().optional() })
              .parse(await response.json());

            if (workflow.status === "errored") throw new Error(JSON.stringify(workflow.error));

            return (await jobState(id))?.state;
          },
          { timeout: 90_000, interval: 100 },
        )
        .toBe(state);
    };

    beforeAll(async () => {
      environment = await createTestEnvironment();
      (await initializeCloudflareFleet(environment.database.db)).unwrap();
      first = await seedDeployment(environment.database.db);
      preview = await seedDeployment(environment.database.db, { groups: largeGroups });

      for (const entry of [first, preview])
        databases.set(resourceName(entry.appId, "d1", "data"), crypto.randomUUID());
      directory = await mkdtemp(join(tmpdir(), "widefleet-deployment-workerd-"));
      api.listen(0, "127.0.0.1");
      await once(api, "listening");
      apiOrigin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(api.address()).port}`;
      await writeFile(join(directory, "runtime.js"), release.modules[0]?.source ?? "");
      const workflow = fileURLToPath(new URL("../../src/deployment-workflow.ts", import.meta.url));

      const dispatcher = fileURLToPath(
        new URL("../../src/lib/server/cloudflare-deployment.ts", import.meta.url),
      );

      await writeFile(
        join(directory, "fixture.ts"),
        `
      import runtime from './runtime.js';
      import { dispatchCloudflareDeployment } from ${JSON.stringify(dispatcher)};
      export * from './runtime.js';
      export { DeploymentWorkflow } from ${JSON.stringify(workflow)};
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        return nativeFetch(url.origin === 'https://api.cloudflare.com' ? new Request(${JSON.stringify(apiOrigin)} + url.pathname + url.search, request) : request);
      };
      export default { async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.hostname === 'fixture' && url.pathname === '/seed') {
          const { artifact, source } = await request.json();
          await env.ARTIFACTS.put('apps/' + artifact.appId + '/modules/' + artifact.modules[0].sha256, source);
          return new Response(null, { status: 204 });
        }
        if (url.hostname === 'fixture' && url.pathname === '/start') {
          await dispatchCloudflareDeployment(env);
          return new Response(null, { status: 204 });
        }
        if (url.hostname === 'fixture' && url.pathname === '/host') {
          const obj = await env.ARTIFACTS.get('hosts/' + url.searchParams.get('hostname') + '.json');
          const key = obj?.customMetadata?.widefleet_access;
          const access = key ? await env.ARTIFACTS.get(key) : null;
          return Response.json(obj ? { body: await obj.json(), access: access ? await access.text() : null } : null);
        }
        if (url.hostname === 'fixture' && url.pathname === '/workflow') {
          const instance = await env.DEPLOYMENTS.get(url.searchParams.get('id'));
          if (request.method === 'POST') {
            if (url.searchParams.get('action') === 'pause') await instance.pause();
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
            APP_RUNTIME_TOKEN: token,
            WIDEFLEET_CONTROL_TOKEN: token,
            WIDEFLEET_CONFIGURATION: JSON.stringify({ crons: {}, queues: {} }),
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
          ],
          services: [{ binding: "APP_RUNTIME", service: "widefleet-deployment-test" }],
          worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
          r2_buckets: [
            { binding: "ARTIFACTS", bucket_name: "artifacts" },
            { binding: "WIDEFLEET_PACKAGES", bucket_name: "artifacts" },
            ...[first, preview].map((entry) => ({
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
      await seed(first);
      await seed(preview);
    }, 45_000);
    afterAll(async () => {
      await worker?.stop();
      api.close();
      await environment?.close();

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("provisions, verifies and activates apps with isolated native D1/R2 data", async () => {
      await dispatch();
      await completed(first.jobId);
      await completed(preview.jobId);
      expect(createdDatabases.size).toBe(2);
      expect(buckets.size).toBe(2);
      expect(patches).toBe(2);
      expect(await host(first.hostname)).toMatchObject({
        body: { deploymentId: first.deploymentId, version: first.jobId },
        access: JSON.stringify({ revision: 1, groups: ["engineering"] }),
      });
      expect((await host(preview.hostname))?.access).toBe(
        JSON.stringify({ revision: 1, groups: largeGroups }),
      );

      const response = await worker.fetch(`https://${first.hostname}/resources`, {
        method: "PUT",
        body: "production fixture",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        rows: [{ value: "production fixture" }],
        file: "production fixture",
      });
      const isolated = await worker.fetch(`https://${preview.hostname}/resources`);
      expect(await isolated.json()).toEqual({ rows: [], file: null });
    }, 100_000);

    it("rejects unsupported capabilities without publishing or provisioning them", async () => {
      const entry = await seedDeployment(environment.database.db, {
        appId: first.appId,
        bindings: [{ type: "kv_namespace", name: "KV", id: "fixture" }],
      });

      await seed(entry);
      await dispatch();
      await completed(entry.jobId, "failed");
      expect((await host(first.hostname))?.body).toMatchObject({
        deploymentId: first.deploymentId,
      });
      expect(patches).toBe(2);
    }, 100_000);

    it("keeps the active version when the candidate cannot start", async () => {
      const entry = await seedDeployment(environment.database.db, {
        appId: first.appId,
        source: "export default { fetch: invalid syntax };",
      });

      await seed(entry);
      await dispatch();
      await completed(entry.jobId, "failed");
      expect((await host(first.hostname))?.body).toMatchObject({
        deploymentId: first.deploymentId,
      });
      expect(await (await worker.fetch(`https://${first.hostname}/`)).text()).toBe(
        "deployed fixture",
      );
      expect((await jobState(entry.jobId))?.activationStartedAt).toBeNull();
    }, 100_000);

    it("recovers activation after a SQL failure and a workerd restart", async () => {
      const entry = await seedDeployment(environment.database.db, {
        appId: first.appId,
        source: deploymentSource.replace("deployed fixture", "second version"),
      });

      await seed(entry);
      await environment.database.db.execute(
        sql.raw(
          `CREATE FUNCTION fixture_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_id = '${entry.jobId}' THEN RAISE EXCEPTION 'fixture completion failure'; END IF; RETURN NEW; END $$`,
        ),
      );
      await environment.database.db.execute(
        sql`CREATE TRIGGER fixture_receipt BEFORE INSERT ON job_receipt FOR EACH ROW EXECUTE FUNCTION fixture_reject_receipt()`,
      );
      await dispatch();
      await expect
        .poll(async () => (await host(entry.hostname))?.body, { timeout: 30_000, interval: 100 })
        .toMatchObject({ deploymentId: entry.deploymentId });
      expect((await jobState(entry.jobId))?.state).toBe("running");
      const workflowUrl = `http://fixture/workflow?id=${entry.jobId}`;
      await worker.fetch(`${workflowUrl}&action=pause`, { method: "POST" });
      await expect
        .poll(async () => {
          const response = await worker.fetch(workflowUrl);

          return z.object({ status: z.string() }).parse(await response.json()).status;
        })
        .toBe("paused");
      await worker.stop();
      await environment.database.db.execute(sql`DROP TRIGGER fixture_receipt ON job_receipt`);
      worker = await start();
      await worker.fetch(`${workflowUrl}&action=resume`, { method: "POST" });
      await dispatch();
      await completed(entry.jobId);
      expect(createdDatabases.size).toBe(2);
      expect(buckets.size).toBe(2);

      const [active] = await environment.database.db
        .select()
        .from(apps)
        .where(eq(apps.id, first.appId));

      expect(active?.activeDeploymentId).toBe(entry.deploymentId);
      expect(await (await worker.fetch(`https://${first.hostname}/`)).text()).toBe(
        "second version",
      );

      const [status] = await environment.database.db
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, entry.deploymentId), eq(deployments.status, "succeeded")));

      expect(status).toBeDefined();
    }, 100_000);
  },
);
