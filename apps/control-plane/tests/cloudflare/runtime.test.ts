import { runtimeIdentity } from "../runtime-identity.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Unstable_DevWorker } from "wrangler";
import { cloudflareLog } from "@platform/app-runtime/logs";
import { publishedApp, runtimeRelease } from "@platform/contracts";
import release from "@platform/app-runtime/release" with { type: "json" };
import { z } from "zod";
import { hashAsset } from "../../src/lib/server/asset-hash.ts";
import { appSource, parentSource } from "./runtime.fixture.ts";
import { executionProfiles } from "./execution-limits.fixture.ts";

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")("App runtime in workerd", () => {
  let directory: string;
  let worker: Unstable_DevWorker;
  let tcpAddress: string;
  let connections = 0;
  let identity: Awaited<ReturnType<typeof runtimeIdentity>>;
  const controlToken = "runtime-fixture-control-token-never-deploy";

  const tcp = createServer((socket) => {
    connections++;
    socket.end();
  });

  const hostname = "app.example.test";
  const previewHostname = "app-pr42.example.test";
  const sourceHash = createHash("sha256").update(appSource).digest("hex");
  const asset = "fixture asset";
  const assetHash = hashAsset("/asset.txt", new TextEncoder().encode(asset));

  const app = publishedApp.parse({
    id: crypto.randomUUID(),
    appId: crypto.randomUUID(),
    version: crypto.randomUUID(),
    deploymentId: crypto.randomUUID(),
    hostname,
    metadata: {
      main_module: "app.js",
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
      bindings: [
        { type: "d1", name: "DB", database_name: "fixture" },
        { type: "kv_namespace", name: "KV", id: "fixture" },
        { type: "r2_bucket", name: "FILES", bucket_name: "fixture" },
        { type: "queue", name: "JOBS", queue: "fixture" },
        {
          type: "workflow",
          name: "WORKFLOW",
          workflow_name: "fixture",
          class_name: "ExampleWorkflow",
        },
      ],
      crons: ["* * * * *"],
      queue_consumers: [{ queue: "fixture" }],
    },
    modules: [
      { name: "app.js", type: "esm", sha256: sourceHash, size: Buffer.byteLength(appSource) },
    ],
    manifest: { "/asset.txt": { hash: assetHash, size: Buffer.byteLength(asset) } },
    nativeBindings: { DB: "DB", KV: "KV", FILES: "FILES", JOBS: "JOBS" },
    capabilities: {
      CONNECTOR: {
        organizationId: crypto.randomUUID(),
        connector: "fixture",
        entrypoint: "default",
      },
    },
    capabilityRevision: 1,
    network: { revision: 1, policy: { backend: ["https://allowed.example.test"], browser: [] } },
  });

  const preview = publishedApp.parse({
    ...app,
    id: crypto.randomUUID(),
    appId: crypto.randomUUID(),
    version: crypto.randomUUID(),
    deploymentId: crypto.randomUUID(),
    hostname: previewHostname,
    nativeBindings: {
      DB: "PREVIEW_DB",
      KV: "PREVIEW_KV",
      FILES: "PREVIEW_FILES",
      JOBS: "PREVIEW_JOBS",
    },
  });

  const fetchApp = (
    path: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
    host = hostname,
  ) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", identity.cookie);

    if (path.startsWith("/.well-known/widefleet/")) headers.set("x-fixture-management", "true");

    return worker.fetch(`https://${host}${path}`, {
      ...init,
      headers: Object.fromEntries(headers),
    });
  };

  const json = async (
    path: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
    host = hostname,
  ) => {
    const response = await fetchApp(path, init, host);
    const body = await response.text();
    expect(response.status, body).toBe(200);

    return z.json().parse(JSON.parse(body));
  };

  const publish = async (record: z.infer<typeof publishedApp>, source = appSource) => {
    const response = await fetchApp("/fixture/publish", {
      method: "POST",
      body: JSON.stringify({
        app: record,
        modules: [{ hash: record.modules[0]?.sha256, source }],
        assets: [{ hash: assetHash, source: asset }],
      }),
    });

    expect(response.status).toBe(204);
  };

  const start = async (logs = "cloudflare") => {
    const { unstable_dev } = await import("wrangler");

    return unstable_dev(join(directory, "index.js"), {
      config: join(directory, "wrangler.json"),
      vars: { WIDEFLEET_LOGS: logs },
      local: true,
      persist: true,
      persistTo: join(directory, "state"),
      ip: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      logLevel: "error",
      experimental: {
        disableExperimentalWarning: true,
        disableDevRegistry: true,
        watch: false,
        testScheduled: true,
      },
    });
  };

  beforeAll(async () => {
    identity = await runtimeIdentity("example.test");
    tcp.listen(0, "127.0.0.1");
    await once(tcp, "listening");
    tcpAddress = `127.0.0.1:${z.object({ port: z.number() }).parse(tcp.address()).port}`;
    directory = await mkdtemp(join(tmpdir(), "widefleet-runtime-workerd-"));
    const runtime = runtimeRelease.parse(release);

    for (const module of runtime.modules)
      await writeFile(
        join(directory, module.name === runtime.main ? "runtime.js" : module.name),
        module.source,
      );
    const main = join(directory, "index.js");
    await writeFile(main, parentSource);
    const config = join(directory, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "widefleet-runtime-test",
        main,
        compatibility_date: "2026-10-01",
        // Miniflare's engine uses its own older date; explicitly select the
        // error behavior enabled on Workers since 2026-05-14.
        compatibility_flags: ["nodejs_compat", "workflows_preserve_non_retryable_error_message"],
        vars: {
          WIDEFLEET_EXECUTION_LIMITS: JSON.stringify(executionProfiles),
          WIDEFLEET_HTTP_AVAILABILITY: "kv",
          WIDEFLEET_LOGS: "cloudflare",
          PRIVATE_ROOT_SECRET: "parent-only-fixture",
          WIDEFLEET_CONTROL_TOKEN: controlToken,
          WIDEFLEET_CONFIGURATION: JSON.stringify({
            crons: { "* * * * *": [hostname, previewHostname] },
            queues: {
              fixture: { hostname, queue: "fixture" },
              preview: { hostname: previewHostname, queue: "fixture" },
            },
          }),
        },
        worker_loaders: [{ binding: "WIDEFLEET_LOADER" }],
        r2_buckets: [
          { binding: "WIDEFLEET_PACKAGES", bucket_name: "packages" },
          { binding: "FILES", bucket_name: "files" },
          { binding: "PREVIEW_FILES", bucket_name: "preview-files" },
        ],
        d1_databases: [
          { binding: "DB", database_name: "fixture", database_id: "fixture" },
          { binding: "PREVIEW_DB", database_name: "preview", database_id: "preview" },
        ],
        kv_namespaces: [
          { binding: "AUTH_CONFIG", id: "auth-config" },
          { binding: "KV", id: "fixture" },
          { binding: "PREVIEW_KV", id: "preview" },
        ],
        queues: {
          producers: [
            { binding: "JOBS", queue: "fixture" },
            { binding: "PREVIEW_JOBS", queue: "preview" },
          ],
          consumers: [
            { queue: "fixture", max_batch_timeout: 0 },
            { queue: "preview", max_batch_timeout: 0 },
          ],
        },
        durable_objects: {
          bindings: [
            { name: "WIDEFLEET_WORKFLOW_CATALOG", class_name: "CloudflareWorkflowCatalog" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["CloudflareWorkflowCatalog"] }],
        services: [
          {
            binding: "RUNTIME_MANAGEMENT",
            service: "widefleet-runtime-test",
            entrypoint: "RuntimeManagement",
          },
        ],
        workflows: [
          {
            binding: "PAUSE_WORKFLOW",
            name: "pause-workflow",
            class_name: "PauseWorkflow",
          },
          {
            binding: "WIDEFLEET_WORKFLOWS",
            name: "app-workflows",
            class_name: "CloudflareAppWorkflow",
          },
        ],
      }),
    );
    worker = await start();
    expect(
      (
        await worker.fetch(
          "https://auth.example.test/.well-known/widefleet/auth/organizations/widefleet/configuration",
          {
            method: "PUT",
            headers: { "x-fixture-management": "true" },
            body: JSON.stringify(identity.configuration),
          },
        )
      ).status,
    ).toBe(204);
    await publish(app);
    await publish(preview);
  }, 30_000);

  afterAll(async () => {
    await worker?.stop();
    await new Promise<void>((resolve, reject) =>
      tcp.close((error) => (error ? reject(error) : resolve())),
    );

    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("protects runtime management endpoints and app assets from unauthenticated requests", async () => {
    for (const path of [
      "/.well-known/widefleet/runtime",
      "/.well-known/widefleet/ready",
      "/.well-known/widefleet/workflows",
      "/.well-known/widefleet/auth/organizations/widefleet/configuration",
    ]) {
      for (const authorization of [
        "",
        "Bearer undefined",
        "Bearer invalid",
        `Bearer ${controlToken}`,
      ]) {
        const response = await worker.fetch(`https://${hostname}${path}`, {
          headers: { authorization },
        });

        expect(response.status).toBe(404);
      }
    }

    const forged = await worker.fetch(`https://${hostname}/asset.txt`, {
      headers: { "x-auth-request-user": "forged", "x-auth-request-email": "forged@example.test" },
    });

    expect(forged.status).toBe(401);
    expect(await forged.text()).not.toBe(asset);

    for (const candidate of ["", `${app.appId}/${app.version}`]) {
      const response = await worker.fetch(`https://${hostname}/asset.txt`, {
        headers: {
          cookie: identity.cookie,
          authorization: `Bearer ${controlToken}`,
          "x-widefleet-candidate": candidate,
        },
      });

      expect(response.status).toBe(404);
    }
  });

  it("uses the private service binding without a token and does not forward app requests", async () => {
    expect(await json("/.well-known/widefleet/runtime")).toEqual({
      runtimeVersion: release.version,
    });
    expect(await json("/.well-known/widefleet/ready")).toMatchObject({ version: app.version });

    const response = await worker.fetch(`https://${hostname}/asset.txt`, {
      headers: { "x-fixture-management": "true", cookie: identity.cookie },
    });

    expect(response.status).toBe(404);
  });

  it("captures actual Dynamic Worker logs with app, preview and version attribution", async () => {
    for (const target of [app, preview]) {
      expect((await fetchApp("/logs", undefined, target.hostname)).status).toBe(200);
      await expect
        .poll(async () => {
          const records = z.array(cloudflareLog).parse(await json("/fixture/logs"));

          return records.filter(
            (record) =>
              record.appId === target.appId &&
              record.record.message.startsWith("fixture plain log"),
          );
        })
        .toMatchObject([
          { appId: target.appId, record: { source: "server", deploymentId: target.deploymentId } },
        ]);
    }

    const records = z.array(cloudflareLog).parse(await json("/fixture/logs"));
    expect(records.filter((record) => record.record.message === "older browser")).toMatchObject([
      { record: { source: "browser", buildId: "older-build", deploymentId: null } },
      { record: { source: "browser", buildId: "older-build", deploymentId: null } },
    ]);
  });

  it("applies per-invocation profiles to cached HTTP, readiness, cron and workflow code", async () => {
    await json("/fixture/executions");
    expect((await fetchApp("/asset.txt")).status).toBe(200);
    expect(await json("/fixture/executions")).toEqual([]);

    const bindings = z.object({ keys: z.array(z.string()), imported: z.array(z.string()) });
    const visible = bindings.parse(await json("/env"));
    expect(visible.keys).not.toContain("WIDEFLEET_EXECUTION_LIMITS");
    expect(visible.imported).not.toContain("WIDEFLEET_EXECUTION_LIMITS");
    expect(await json("/fixture/executions")).toEqual([
      { key: app.version, entrypoint: null, limits: executionProfiles.http },
    ]);

    const http = { cpuMs: 25, subRequests: 5 };
    await json("/env", {
      headers: {
        "x-fixture-execution-policy": JSON.stringify({ ...executionProfiles, http }),
      },
    });
    expect(await json("/fixture/executions")).toEqual([
      { key: app.version, entrypoint: null, limits: http },
    ]);

    await json("/.well-known/widefleet/ready");
    expect(await json("/fixture/executions")).toEqual([
      { key: app.version, entrypoint: "Events", limits: executionProfiles.readiness },
      { key: null, entrypoint: "WorkflowRunner", limits: executionProfiles.readiness },
    ]);

    await json("/fixture/scheduled", {
      method: "POST",
      body: JSON.stringify({ time: 1, reset: true, mode: "disabled" }),
    });
    expect(await json("/fixture/executions")).toEqual(
      expect.arrayContaining([
        { key: app.version, entrypoint: "Events", limits: executionProfiles.cron },
        { key: preview.version, entrypoint: "Events", limits: executionProfiles.cron },
      ]),
    );

    const path = `/workflow?id=${crypto.randomUUID()}&mode=sleep`;
    await json(path, { method: "POST" });
    await expect.poll(() => json(path), { timeout: 15_000 }).toMatchObject({ status: "complete" });
    expect(await json("/fixture/executions")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entrypoint: "WorkflowRunner",
          limits: executionProfiles.workflow,
        }),
      ]),
    );
  }, 30_000);

  it("does not invoke cached application code when a configured execution policy is invalid", async () => {
    await json("/env");
    await json("/fixture/executions");

    for (const policy of ["", "{}", "not-json"])
      expect(
        (await fetchApp("/env", { headers: { "x-fixture-execution-policy": policy } })).status,
      ).toBe(500);
    expect(await json("/fixture/executions")).toEqual([]);
    expect((await fetchApp("/env")).status).toBe(200);
  });

  it("rejects invalid workflow session policies before loading a fresh Worker", async () => {
    const body = JSON.stringify({
      appId: app.appId,
      version: app.version,
      hostname,
      workflow: "fixture",
      id: crypto.randomUUID(),
      params: {},
    });

    await json("/fixture/executions");

    for (const policy of ["", "{}", "not-json"]) {
      const result = z.object({ loads: z.number(), error: z.string() }).parse(
        await json("/fixture/workflow-session", {
          method: "POST",
          body,
          headers: { "x-fixture-execution-policy": policy },
        }),
      );

      expect(result.loads).toBe(0);
    }

    expect(await json("/fixture/executions")).toEqual([]);

    expect(await json("/fixture/workflow-session", { method: "POST", body })).toEqual({ loads: 1 });
    expect(await json("/fixture/executions")).toEqual([
      { key: null, entrypoint: "WorkflowRunner", limits: executionProfiles.workflow },
    ]);
  });

  it("captures native uncaught failures without replacing the app error", async () => {
    expect((await fetchApp("/throw")).status).toBe(500);
    await expect
      .poll(async () => {
        const records = z.array(cloudflareLog).parse(await json("/fixture/logs"));

        return records.find((record) =>
          record.record.message.includes("fixture application failure"),
        );
      })
      .toMatchObject({
        appId: app.appId,
        record: {
          source: "runtime",
          kind: "span_error",
          level: "error",
          deploymentId: app.deploymentId,
        },
      });
  });

  it("loads immutable app modules and assets from R2 by hostname", async () => {
    expect(await json("/.well-known/widefleet/ready")).toMatchObject({
      version: app.version,
      deploymentId: app.deploymentId,
    });
    const response = await fetchApp("/asset.txt");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(asset);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await fetchApp("/env", undefined, "missing.example.test")).status).toBe(404);
  });

  const availability = async (value: string | null, organizationId = "widefleet") => {
    expect(
      (
        await fetchApp("/fixture/availability", {
          method: "POST",
          body: JSON.stringify({ organizationId, value }),
        })
      ).status,
    ).toBe(204);
  };

  it("blocks HTTP for every app in an org, including new publications, without blocking management", async () => {
    await availability(JSON.stringify({ blocked: true }), "other-organization");
    expect((await fetchApp("/asset.txt")).status).toBe(200);
    await availability(JSON.stringify({ blocked: true }));

    try {
      for (const host of [hostname, previewHostname])
        for (const path of ["/", "/asset.txt"]) {
          const response = await fetchApp(path, undefined, host);
          expect(response.status).toBe(429);
          expect(response.headers.get("cache-control")).toBe("no-store");
        }

      await publish(preview);
      expect((await fetchApp("/asset.txt", undefined, previewHostname)).status).toBe(429);
      expect(
        (
          await fetchApp("/asset.txt", {
            headers: { "x-fixture-storage-mode": "disabled" },
          })
        ).status,
      ).toBe(200);

      expect(await json("/.well-known/widefleet/ready")).toMatchObject({ version: app.version });
    } finally {
      await availability(JSON.stringify({ blocked: false }));
      await availability(null, "other-organization");
    }

    expect((await fetchApp("/asset.txt")).status).toBe(200);
    expect((await fetchApp("/asset.txt", undefined, previewHostname)).status).toBe(200);
    await availability(null);
  });

  it("starts the KV lookup alongside the R2 host read", async () => {
    expect(
      (
        await fetchApp("/asset.txt", {
          headers: { "x-fixture-storage-mode": "parallel" },
        })
      ).status,
    ).toBe(200);
  });

  it("returns 503 for unreadable or invalid status, while a missing entry allows requests", async () => {
    try {
      for (const value of ["broken-json", JSON.stringify({ blocked: "false" })]) {
        await availability(value);
        expect((await fetchApp("/asset.txt")).status).toBe(503);
      }

      await availability(null);

      const failed = await fetchApp("/asset.txt", {
        headers: { "x-fixture-storage-mode": "kv-error" },
      });

      expect(failed.status).toBe(503);
      expect(failed.headers.get("cache-control")).toBe("no-store");
      expect((await fetchApp("/asset.txt")).status).toBe(200);
    } finally {
      await availability(null);
    }
  });

  it("preserves the original application error", async () => {
    const response = await fetchApp("/throw", {
      headers: { "MF-Experimental-Error-Stack": "true" },
    });

    expect(response.status).toBe(500);
    expect(z.object({ message: z.string() }).parse(await response.json()).message).toBe(
      "fixture application failure",
    );
    expect(await json("/connector")).toBe(42);
  });

  it("exposes granted connector RPC without leaking parent bindings", async () => {
    expect(await json("/connector")).toBe(42);

    const result = z
      .object({ keys: z.array(z.string()), imported: z.array(z.string()) })
      .parse(await json("/env"));

    expect(result.keys).toEqual(result.imported);
    expect(result.keys).toContain("DB");
    expect(result.keys).toContain("CONNECTOR");

    for (const key of [
      "PRIVATE_ROOT_SECRET",
      "WIDEFLEET_CONTROL_TOKEN",
      "WIDEFLEET_LOADER",
      "WIDEFLEET_PACKAGES",
      "PREVIEW_DB",
    ])
      expect(result.keys).not.toContain(key);
  });

  it("isolates D1, KV and R2 data between the app and its preview", async () => {
    expect(await json("/resources", { method: "PUT", body: "production" })).toEqual({
      rows: [{ value: "production" }],
      kv: "production",
      file: "production",
    });
    expect(await json("/resources", undefined, previewHostname)).toEqual({
      rows: [],
      kv: null,
      file: null,
    });
    expect(await json("/resources", { method: "PUT", body: "preview" }, previewHostname)).toEqual({
      rows: [{ value: "preview" }],
      kv: "preview",
      file: "preview",
    });
    expect(await json("/resources")).toEqual({
      rows: [{ value: "production" }],
      kv: "production",
      file: "production",
    });
  });

  it("checks outbound fetches and redirects and blocks direct TCP", async () => {
    expect(await json("/fetch?url=https://allowed.example.test/ok")).toEqual({
      status: 200,
      body: "allowed fixture",
    });

    for (const url of [
      "https://denied.example.test/private",
      "https://allowed.example.test/redirect",
      "http://allowed.example.test/ok",
    ])
      expect(await json(`/fetch?${new URLSearchParams({ url })}`)).toMatchObject({ status: 403 });
    const query = new URLSearchParams({ address: tcpAddress });
    expect(await json(`/fixture/tcp?${query}`)).toEqual({ connected: true });
    expect(connections).toBe(1);
    const denied = z.object({ error: z.string() }).parse(await json(`/tcp?${query}`));

    expect(denied.error).toContain("proxy request failed");
    expect(connections).toBe(1);
  });

  it("delivers native queue messages to the matching app and preview", async () => {
    await json("/queue", { method: "POST", body: "production-message" });
    await json("/queue", { method: "POST", body: "preview-message" }, previewHostname);
    await expect.poll(() => json("/queue"), { timeout: 10_000 }).toBe("production-message");
    await expect
      .poll(() => json("/queue", undefined, previewHostname), { timeout: 10_000 })
      .toBe("preview-message");
  }, 25_000);

  it("dispatches a scheduled event with app bindings and waitUntil", async () => {
    const response = await fetchApp(`/__scheduled?${new URLSearchParams({ cron: "* * * * *" })}`);
    expect(response.status).toBe(200);
    expect(await json("/cron")).toBe("* * * * *");
    expect(await json("/cron", undefined, previewHostname)).toBe("* * * * *");
  });

  const scheduled = async (time: number, options: { mode?: string; reset?: boolean } = {}) =>
    z.object({ error: z.string().nullable(), runs: z.array(z.array(z.number()).nullable()) }).parse(
      await json("/fixture/scheduled", {
        method: "POST",
        body: JSON.stringify({ time, ...options }),
      }),
    );

  const publishRoute = async (value: string | null, host = hostname) => {
    expect(
      (
        await fetchApp("/fixture/auth-route", {
          method: "POST",
          body: JSON.stringify({ hostname: host, value }),
        })
      ).status,
    ).toBe(204);
  };

  const separatePreviewOrganization = () =>
    publishRoute(
      JSON.stringify({
        organizationId: "other-organization",
        appId: preview.appId,
        access: { revision: 1, groups: [] },
      }),
      previewHostname,
    );

  it("skips all cron apps of a blocked org and resumes only at the next scheduled time", async () => {
    await availability(null);
    expect(await scheduled(100, { reset: true })).toEqual({ error: null, runs: [[100], [100]] });
    await availability(JSON.stringify({ blocked: true }));

    try {
      // Re-publishing an app must not bypass its organization's suspension.
      await publish(preview);
      expect(await scheduled(200)).toEqual({ error: null, runs: [[100], [100]] });
      expect(await scheduled(300)).toEqual({ error: null, runs: [[100], [100]] });
      await availability(JSON.stringify({ blocked: false }));
      expect(await scheduled(400)).toEqual({
        error: null,
        runs: [
          [100, 400],
          [100, 400],
        ],
      });
    } finally {
      await availability(null);
    }
  });

  it("continues cron delivery to other orgs when one org is blocked", async () => {
    await separatePreviewOrganization();
    await availability(JSON.stringify({ blocked: true }));

    try {
      expect(await scheduled(100, { reset: true })).toEqual({ error: null, runs: [null, [100]] });
      await availability(JSON.stringify({ blocked: false }));
      await availability(JSON.stringify({ blocked: true }), "other-organization");
      expect(await scheduled(200)).toEqual({ error: null, runs: [[200], [100]] });
    } finally {
      await availability(null);
      await availability(null, "other-organization");
      await publish(preview);
    }
  });

  it("does not read cron admission data when the existing org gate is disabled", async () => {
    await availability(JSON.stringify({ blocked: true }));

    try {
      // The fixture throws on any AUTH_CONFIG read in this mode.
      expect(await scheduled(100, { reset: true, mode: "disabled" })).toEqual({
        error: null,
        runs: [[100], [100]],
      });
    } finally {
      await availability(null);
    }
  });

  it("fails affected cron deliveries on invalid or unreadable status and still runs other orgs", async () => {
    await separatePreviewOrganization();

    try {
      for (const value of ["broken-json", JSON.stringify({ blocked: "false" })]) {
        await availability(value);
        expect(await scheduled(100, { reset: true })).toEqual({
          error: "App cron delivery failed",
          runs: [null, [100]],
        });
      }

      await availability(null);
      expect(await scheduled(200, { reset: true, mode: "status-error" })).toEqual({
        error: "App cron delivery failed",
        runs: [null, [200]],
      });
      expect(await scheduled(300)).toEqual({ error: null, runs: [[300], [200, 300]] });
    } finally {
      await availability(null);
      await publish(preview);
    }
  });

  it("requires a readable org route matching the cron app before checking suspension", async () => {
    await separatePreviewOrganization();

    try {
      for (const value of [
        null,
        "broken-json",
        JSON.stringify({
          organizationId: "widefleet",
          appId: preview.appId,
          access: { revision: 1, groups: [] },
        }),
      ]) {
        await publishRoute(value);
        expect(await scheduled(100, { reset: true })).toEqual({
          error: "App cron delivery failed",
          runs: [null, [100]],
        });
      }

      await publish(app);
      expect(await scheduled(200, { reset: true, mode: "route-error" })).toEqual({
        error: "App cron delivery failed",
        runs: [null, [200]],
      });
      expect(await scheduled(300)).toEqual({ error: null, runs: [[300], [200, 300]] });
    } finally {
      await publish(app);
      await publish(preview);
    }
  });

  it("resumes an app workflow with its own resources and connector", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}`;
    expect(await json(path, { method: "POST" })).toEqual({ id });
    await expect.poll(() => json("/workflow/steps"), { timeout: 15_000 }).toEqual([{ id }]);
    expect(await json(path, { method: "PUT" })).toEqual({ ok: true });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({ status: "complete", output: 42 });
    expect(await json("/workflow/steps")).toEqual([{ id }]);
  }, 35_000);

  const workflowWorkers = async (id: string) =>
    z
      .array(z.object({ instanceId: z.string(), key: z.string().nullable(), loads: z.number() }))
      .parse(await json("/fixture/workflow-workers"))
      .filter((record) => record.instanceId === id);

  it("reuses a Worker across sequential and concurrent instances without sharing step state", async () => {
    const warmId = crypto.randomUUID();
    const warm = `/workflow?id=${warmId}&mode=worker-cache&value=10`;
    await json(warm, { method: "POST" });
    await expect
      .poll(() => json(warm), { timeout: 15_000 })
      .toMatchObject({ status: "complete", output: { instanceId: warmId, value: 10 } });
    const [warmed] = await workflowWorkers(warmId);
    expect(warmed?.key).toMatch(/^cloudflare-workflow\/[a-f0-9]{64}$/);

    const instances = [20, 30].map((value) => {
      const id = crypto.randomUUID();

      return { id, value, path: `/workflow?id=${id}&mode=worker-cache&wait=true&value=${value}` };
    });

    await Promise.all(instances.map(({ path }) => json(path, { method: "POST" })));

    for (const { id, value, path } of instances) {
      await expect
        .poll(() => json(`/workflow/attempts?id=${id}`), { timeout: 15_000 })
        .toEqual([{ label: "started", attempt: 1 }]);
      expect(await workflowWorkers(id)).toEqual([{ instanceId: id, key: warmed?.key, loads: 0 }]);
      await json(path, { method: "PUT" });
      await expect
        .poll(() => json(path), { timeout: 15_000 })
        .toMatchObject({
          status: "complete",
          output: { instanceId: id, value, workflowName: "fixture", handler: "example" },
        });
    }
  }, 35_000);

  it("separates cached Workers by app and workflow even when version IDs match", async () => {
    const multiple = publishedApp.parse({
      ...app,
      version: crypto.randomUUID(),
      metadata: {
        ...app.metadata,
        bindings: [
          ...app.metadata.bindings,
          { type: "workflow", name: "OTHER", workflow_name: "other", class_name: "OtherWorkflow" },
        ],
      },
    });

    await publish(multiple);
    await publish(publishedApp.parse({ ...preview, version: multiple.version }));

    try {
      const id = crypto.randomUUID();

      // Invoke bindings directly so this checks the Workflow cache independently
      // of the HTTP loader's globally unique publication-version IDs.
      for (const { target, workflowName, handler } of [
        { target: multiple, workflowName: "fixture", handler: "example" },
        { target: multiple, workflowName: "other", handler: "other" },
        { target: preview, workflowName: "fixture", handler: "example" },
      ]) {
        const scope = { appId: target.appId, hostname: target.hostname, workflow: workflowName };
        await json("/fixture/workflow-binding", {
          method: "POST",
          body: JSON.stringify({
            scope,
            method: "create",
            options: { id, params: { mode: "worker-cache" } },
          }),
        });
        await expect
          .poll(
            () =>
              json("/fixture/workflow-binding", {
                method: "POST",
                body: JSON.stringify({ scope, method: "instance", id, action: "status" }),
              }),
            { timeout: 15_000 },
          )
          .toMatchObject({ status: "complete", output: { instanceId: id, workflowName, handler } });
      }

      const keys = (await workflowWorkers(id)).map((record) => record.key);
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(3);
    } finally {
      await publish(app);
      await publish(preview);
    }
  }, 35_000);

  it("refreshes outbound policy when a pinned workflow resumes with a warm Worker cache", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=worker-cache&wait=true`;
    await json(path, { method: "POST" });
    await expect
      .poll(() => json(`/workflow/attempts?id=${id}`), { timeout: 15_000 })
      .toEqual([{ label: "started", attempt: 1 }]);
    const [original] = await workflowWorkers(id);
    await json(`${path}&action=pause`, { method: "PUT" });
    await expect.poll(() => json(path), { timeout: 15_000 }).toMatchObject({ status: "paused" });
    await publish(
      publishedApp.parse({
        ...app,
        version: crypto.randomUUID(),
        network: { ...app.network, revision: 2, policy: { backend: [], browser: [] } },
      }),
    );

    try {
      await json(path, { method: "PUT" });
      await json(`${path}&action=resume`, { method: "PUT" });
      await expect
        .poll(() => json(path), { timeout: 15_000 })
        .toMatchObject({ status: "complete", output: { network: 403, connector: true } });
      const resumed = (await workflowWorkers(id)).at(-1);
      expect(resumed?.key).not.toBe(original?.key);
      expect(await json(`/workflow/attempts?id=${id}`)).toEqual([{ label: "started", attempt: 1 }]);
    } finally {
      await publish(app);
    }
  }, 35_000);

  it.each(["url", "token"])(
    "refreshes a cached workflow's collector %s without exposing it in its ID",
    async (field) => {
      const telemetry = {
        url:
          field === "url"
            ? "https://collector.example.test/new"
            : "https://collector.example.test/old",
        token: field === "token" ? "synthetic-new-token" : "synthetic-old-token",
      };

      const original = publishedApp.parse({
        ...app,
        version: crypto.randomUUID(),
        telemetry: { url: "https://collector.example.test/old", token: "synthetic-old-token" },
      });

      await publish(original);
      await worker.stop();
      worker = await start("");

      const collect = async (id: string) =>
        z
          .array(z.object({ url: z.string(), authorization: z.string(), body: z.string() }))
          .parse(await json("/fixture/collector-requests"))
          .filter((request) => request.body.includes(`worker-cache:${id}`));

      try {
        const warmId = crypto.randomUUID();
        const warm = `/workflow?id=${warmId}&mode=worker-cache`;
        await json(warm, { method: "POST" });
        await expect
          .poll(() => json(warm), { timeout: 15_000 })
          .toMatchObject({ status: "complete" });
        await expect
          .poll(() => collect(warmId), { timeout: 5000 })
          .toMatchObject([
            {
              url: "https://collector.example.test/old/v1/logs",
              authorization: "Bearer synthetic-old-token",
            },
          ]);
        const [warmed] = await workflowWorkers(warmId);
        const id = crypto.randomUUID();
        const path = `/workflow?id=${id}&mode=worker-cache&wait=true`;
        await json(path, { method: "POST" });
        await expect
          .poll(() => json(`/workflow/attempts?id=${id}`), { timeout: 15_000 })
          .toEqual([{ label: "started", attempt: 1 }]);
        expect(await workflowWorkers(id)).toEqual([{ instanceId: id, key: warmed?.key, loads: 0 }]);
        await json(`${path}&action=pause`, { method: "PUT" });
        await expect
          .poll(() => json(path), { timeout: 15_000 })
          .toMatchObject({ status: "paused" });
        await publish(
          publishedApp.parse({
            ...original,
            version: crypto.randomUUID(),
            telemetry,
          }),
        );
        await json(path, { method: "PUT" });
        await json(`${path}&action=resume`, { method: "PUT" });
        await expect
          .poll(() => json(path), { timeout: 15_000 })
          .toMatchObject({ status: "complete" });
        await expect
          .poll(() => collect(id), { timeout: 5000 })
          .toMatchObject([
            {
              url: `${telemetry.url}/v1/logs`,
              authorization: `Bearer ${telemetry.token}`,
            },
          ]);
        const resumed = (await workflowWorkers(id)).at(-1);
        expect(resumed?.key).toMatch(/^cloudflare-workflow\/[a-f0-9]{64}$/);
        expect(resumed?.key).not.toBe(warmed?.key);
      } finally {
        await publish(app);
        await worker.stop();
        worker = await start();
      }
    },
    55_000,
  );

  it("rejects corrupt module bytes before evaluating the app", async () => {
    const corrupt = publishedApp.parse({
      ...app,
      appId: crypto.randomUUID(),
      version: crypto.randomUUID(),
      hostname: "corrupt.example.test",
    });

    await publish(corrupt, "throw new Error('corrupt module was executed');");

    const response = await fetchApp(
      "/env",
      { headers: { "MF-Experimental-Error-Stack": "true" } },
      corrupt.hostname,
    );

    expect(response.status).toBe(500);
    expect(z.object({ message: z.string() }).parse(await response.json()).message).toBe(
      "Published module checksum mismatch",
    );
  });

  it("keeps simultaneous workflow instances separate for the app and preview", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}`;
    await Promise.all(
      [hostname, previewHostname].map((host) => json(path, { method: "POST" }, host)),
    );

    for (const host of [hostname, previewHostname])
      await expect
        .poll(() => json("/workflow/steps", undefined, host), { timeout: 15_000 })
        .toContainEqual({ id });
    await json(path, { method: "PUT" });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({ status: "complete", output: 42 });
    expect(await json(path, undefined, previewHostname)).not.toMatchObject({ status: "complete" });
    await json(path, { method: "PUT" }, previewHostname);
    await expect
      .poll(() => json(path, undefined, previewHostname), { timeout: 15_000 })
      .toMatchObject({ status: "complete", output: 42 });
  }, 35_000);

  it("does not retry a terminal step error with a custom name", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=fatal`;
    await json(path, { method: "POST" });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({
        status: "errored",
        error: { name: "ApplicationFailure", message: "permanent fixture" },
      });
    expect(await json(`/workflow/attempts?id=${id}`)).toEqual([{ label: "failure", attempt: 1 }]);
    await expect
      .poll(async () => {
        const records = z.array(cloudflareLog).parse(await json("/fixture/logs"));

        return records.filter(
          (record) =>
            record.appId === app.appId &&
            record.record.level === "error" &&
            record.record.message.includes("permanent fixture"),
        ).length;
      })
      .toBe(1);
  }, 20_000);

  it("uses native retries and exposes the app step name and attempt", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=retry`;
    await json(path, { method: "POST" });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({
        status: "complete",
        output: { step: { name: "retry", count: 1 }, attempt: 3 },
      });
    expect(await json(`/workflow/attempts?id=${id}`)).toEqual([
      { label: "retry", attempt: 1 },
      { label: "retry", attempt: 2 },
      { label: "retry", attempt: 3 },
    ]);
  }, 20_000);

  it("runs repeated parallel steps while an independent event is pending", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=parallel`;
    await json(path, { method: "POST" });
    await expect
      .poll(() => json(`/workflow/attempts?id=${id}`), { timeout: 15_000 })
      .toHaveLength(2);
    await json(path, { method: "PUT" });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({
        status: "complete",
        output: [
          { value: 1, step: { name: "same", count: 1 } },
          { value: 2, step: { name: "same", count: 2 } },
          { type: "continue", payload: { add: 21 } },
        ],
      });
  }, 35_000);

  it("uses native sleep and sleepUntil", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=sleep`;
    await json(path, { method: "POST" });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({
        status: "complete",
        output: { step: { name: "awake", count: 1 } },
      });
    expect(await json(`/workflow/attempts?id=${id}`)).toEqual([{ label: "awake", attempt: 1 }]);
  }, 20_000);

  it("rejects nested steps without retrying", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=nested`;
    await json(path, { method: "POST" });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({
        status: "errored",
        error: { name: "NonRetryableError", message: "Workflow steps cannot be nested" },
      });
  }, 20_000);

  it("restarts a selected native step while keeping earlier results", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=restart`;
    await json(path, { method: "POST" });
    await expect.poll(() => json(path), { timeout: 15_000 }).toMatchObject({ status: "complete" });
    await json(`${path}&action=restart`, { method: "PUT" });
    await expect
      .poll(() => json(`/workflow/attempts?id=${id}`), { timeout: 15_000 })
      .toEqual([
        { label: "first", attempt: 1 },
        { label: "second", attempt: 1 },
        { label: "second", attempt: 1 },
      ]);
    await expect.poll(() => json(path), { timeout: 15_000 }).toMatchObject({ status: "complete" });
  }, 35_000);

  it("does not execute failure-recording steps while a native workflow is paused", async () => {
    const path = `/fixture/pause-workflow?id=${crypto.randomUUID()}`;
    await json(path, { method: "POST" });
    await expect.poll(() => json(path), { timeout: 15_000 }).toMatchObject({ started: true });
    await json(`${path}&action=pause`, { method: "PUT" });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({ status: "paused", caught: true });
    expect(await json(path)).toMatchObject({ failed: false });
    await json(`${path}&action=resume`, { method: "PUT" });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({ status: "complete", output: "recovered", failed: false });
  }, 35_000);

  it("restores a caught terminal error after restarting workerd", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=caught`;
    await json(path, { method: "POST" });
    await expect
      .poll(() => json(`/workflow/attempts?id=${id}`), { timeout: 15_000 })
      .toEqual([{ label: "failure", attempt: 1 }]);
    await expect
      .poll(() => json(`/workflow/error?id=${id}`), { timeout: 15_000 })
      .toEqual({
        name: "ApplicationFailure",
        message: "permanent fixture",
        permanent: true,
      });
    await json(`${path}&action=pause`, { method: "PUT" });
    await expect.poll(() => json(path), { timeout: 15_000 }).toMatchObject({ status: "paused" });
    await worker.stop();
    worker = await start();
    await json(path, { method: "PUT" });
    await json(`${path}&action=resume`, { method: "PUT" });
    await expect
      .poll(() => json(path), { timeout: 15_000 })
      .toMatchObject({
        status: "complete",
        output: { name: "ApplicationFailure", message: "permanent fixture", permanent: true },
      });
    expect(await json(`/workflow/attempts?id=${id}`)).toEqual([{ label: "failure", attempt: 1 }]);
  }, 55_000);

  it("rechecks connector grants when a pinned workflow resumes with a warm Worker cache", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=permissions`;
    await json(path, { method: "POST" });
    await expect
      .poll(async () => (await workflowWorkers(id))[0]?.key, { timeout: 15_000 })
      .toMatch(/^cloudflare-workflow\//);
    const [original] = await workflowWorkers(id);
    await json(`${path}&action=pause`, { method: "PUT" });
    await expect.poll(() => json(path), { timeout: 15_000 }).toMatchObject({ status: "paused" });
    await publish(publishedApp.parse({ ...app, version: crypto.randomUUID(), capabilities: {} }));

    try {
      await json(path, { method: "PUT" });
      await json(`${path}&action=resume`, { method: "PUT" });
      await expect
        .poll(() => json(path), { timeout: 15_000 })
        .toMatchObject({
          status: "complete",
          output: { connector: false, secret: null },
        });
      expect((await workflowWorkers(id)).at(-1)?.key).not.toBe(original?.key);
    } finally {
      await publish(app);
    }
  }, 55_000);

  it("resumes cached pinned code after a deployment while new instances use the new version", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}`;
    await json(path, { method: "POST" });
    await expect.poll(() => json("/workflow/steps"), { timeout: 15_000 }).toContainEqual({ id });
    const [original] = await workflowWorkers(id);
    await json(`${path}&action=pause`, { method: "PUT" });
    await expect.poll(() => json(path), { timeout: 15_000 }).toMatchObject({ status: "paused" });

    const source = appSource.replace(
      "() => value + next.payload.add",
      "() => value + next.payload.add + 100",
    );

    expect(source).not.toBe(appSource);
    await publish(
      publishedApp.parse({
        ...app,
        version: crypto.randomUUID(),
        modules: [
          {
            name: "app.js",
            type: "esm",
            sha256: createHash("sha256").update(source).digest("hex"),
            size: Buffer.byteLength(source),
          },
        ],
      }),
      source,
    );

    try {
      await json(path, { method: "PUT" });
      await json(`${path}&action=resume`, { method: "PUT" });
      await expect
        .poll(() => json(path), { timeout: 15_000 })
        .toMatchObject({ status: "complete", output: 42 });
      expect((await workflowWorkers(id)).at(-1)).toEqual({
        instanceId: id,
        key: original?.key,
        loads: 0,
      });
      const nextId = crypto.randomUUID();
      const next = `/workflow?id=${nextId}`;
      await json(next, { method: "POST" });
      await json(next, { method: "PUT" });
      await expect
        .poll(() => json(next), { timeout: 15_000 })
        .toMatchObject({ status: "complete", output: 142 });
      expect((await workflowWorkers(nextId))[0]?.key).not.toBe(original?.key);
    } finally {
      await publish(app);
    }
  }, 55_000);

  it("preserves app data and waiting workflows across runtime updates and rollbacks", async () => {
    const original = runtimeRelease
      .parse(release)
      .modules.find((module) => module.name === release.main);

    if (!original) throw new Error("Runtime entry module is missing");
    const upgradedVersion = "99.0.0";

    const upgraded = original.source.replaceAll(
      `runtimeVersion: "${release.version}"`,
      `runtimeVersion: "${upgradedVersion}"`,
    );

    expect(upgraded).not.toBe(original.source);

    const snapshots = await Promise.all(
      [hostname, previewHostname].map((host) =>
        json("/resources", { method: "PUT", body: `before-runtime-update:${host}` }, host),
      ),
    );

    try {
      for (const [version, source] of [
        [upgradedVersion, upgraded],
        [release.version, original.source],
      ] as const) {
        const id = crypto.randomUUID();
        const path = `/workflow?id=${id}`;
        await json(path, { method: "POST" });
        await expect
          .poll(() => json("/workflow/steps"), { timeout: 15_000 })
          .toContainEqual({ id });
        await json(`${path}&action=pause`, { method: "PUT" });
        await expect.poll(() => json(path)).toMatchObject({ status: "paused" });

        await worker.stop();
        await writeFile(join(directory, "runtime.js"), source);
        worker = await start();

        expect(await json("/.well-known/widefleet/runtime")).toEqual({ runtimeVersion: version });
        expect(
          await Promise.all(
            [hostname, previewHostname].map((host) => json("/resources", undefined, host)),
          ),
        ).toEqual(snapshots);

        for (const host of [hostname, previewHostname]) {
          expect(await json("/connector", undefined, host)).toBe(42);
          expect(await json("/.well-known/widefleet/ready", undefined, host)).toMatchObject({
            runtimeVersion: version,
          });
        }

        await json(path, { method: "PUT" });
        await json(`${path}&action=resume`, { method: "PUT" });
        await expect
          .poll(() => json(path), { timeout: 15_000 })
          .toMatchObject({ status: "complete", output: 42 });
        const steps = z.array(z.object({ id: z.uuid() })).parse(await json("/workflow/steps"));
        expect(steps.filter((entry) => entry.id === id)).toEqual([{ id }]);
      }
    } finally {
      await worker.stop();
      await writeFile(join(directory, "runtime.js"), original.source);
      worker = await start();
    }
  }, 80_000);

  const workflowBinding = (
    input: Record<string, z.infer<ReturnType<typeof z.json>>>,
    target = app,
  ) =>
    fetchApp("/fixture/workflow-binding", {
      method: "POST",
      body: JSON.stringify({
        scope: { appId: target.appId, hostname: target.hostname, workflow: "fixture" },
        ...input,
      }),
    });

  const manageWorkflow = (
    request: Record<string, z.infer<ReturnType<typeof z.json>>>,
    requestId = crypto.randomUUID(),
    target = app,
  ) =>
    fetchApp("/.well-known/widefleet/workflows", {
      method: "POST",
      body: JSON.stringify({
        appId: target.appId,
        hostname: target.hostname,
        requestId,
        request: { workflow: "fixture", ...request },
      }),
    });

  const rejectedWorkflow = async (
    response: Awaited<ReturnType<typeof fetchApp>>,
    message: string,
  ) => {
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
  };

  it("blocks Workflow creation through bindings and management, then accepts the same IDs after unblock", async () => {
    const single = crypto.randomUUID();
    const batch = [crypto.randomUUID(), crypto.randomUUID()];
    const managed = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const params = { mode: "sleep" };
    await availability(JSON.stringify({ blocked: true }));

    try {
      await rejectedWorkflow(
        await workflowBinding({ method: "create", options: { id: single, params } }),
        "Organization execution is suspended",
      );
      await rejectedWorkflow(
        await workflowBinding({
          method: "createBatch",
          options: batch.map((id) => ({ id, params })),
        }),
        "Organization execution is suspended",
      );
      await rejectedWorkflow(
        await manageWorkflow({ action: "create", id: managed, params }, requestId),
        "Organization execution is suspended",
      );

      const listed = z
        .object({ result: z.object({ instances: z.array(z.object({ id: z.string() })) }) })
        .parse(await (await manageWorkflow({ action: "list" })).json());

      expect(listed.result.instances.map((record) => record.id)).not.toContain(single);
      expect(listed.result.instances.map((record) => record.id)).not.toContain(managed);
      await availability(JSON.stringify({ blocked: false }));
      expect(
        await (await workflowBinding({ method: "create", options: { id: single, params } })).json(),
      ).toEqual({ id: single });
      expect(
        await (
          await workflowBinding({
            method: "createBatch",
            options: batch.map((id) => ({ id, params })),
          })
        ).json(),
      ).toEqual(batch.map((id) => ({ id })));
      expect(
        await (await manageWorkflow({ action: "create", id: managed, params }, requestId)).json(),
      ).toEqual({ result: { id: managed } });
    } finally {
      await availability(null);

      for (const id of [single, ...batch, managed]) await manageWorkflow({ action: "delete", id });
    }
  }, 30_000);

  it("rejects Workflow resumes and restarts while retaining access to existing instances", async () => {
    const id = crypto.randomUUID();
    const terminated = crypto.randomUUID();
    expect((await manageWorkflow({ action: "create", id, params: { value: 20 } })).status).toBe(
      200,
    );
    expect(
      (await manageWorkflow({ action: "create", id: terminated, params: { value: 20 } })).status,
    ).toBe(200);
    await expect
      .poll(() => json("/workflow/steps"), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([{ id }, { id: terminated }]));
    await availability(JSON.stringify({ blocked: true }));

    try {
      expect((await workflowBinding({ method: "get", id })).status).toBe(200);
      expect((await workflowBinding({ method: "instance", id, action: "status" })).status).toBe(
        200,
      );
      expect((await manageWorkflow({ action: "list" })).status).toBe(200);
      expect((await manageWorkflow({ action: "pause", id })).status).toBe(200);
      expect((await manageWorkflow({ action: "terminate", id: terminated })).status).toBe(200);
      expect((await manageWorkflow({ action: "delete", id: terminated })).status).toBe(200);

      for (const action of ["resume", "restart"]) {
        await rejectedWorkflow(
          await workflowBinding({ method: "instance", id, action }),
          "Organization execution is suspended",
        );
        await rejectedWorkflow(
          await manageWorkflow({ action, id }),
          "Organization execution is suspended",
        );
      }

      await availability(JSON.stringify({ blocked: false }));
      expect((await manageWorkflow({ action: "resume", id })).status).toBe(200);
      await availability(JSON.stringify({ blocked: true }));
      // An existing execution may finish; sendEvent does not create a new instance.
      expect(
        (
          await manageWorkflow({
            action: "sendEvent",
            id,
            event: { type: "continue", payload: { add: 21 } },
          })
        ).status,
      ).toBe(200);
      await expect
        .poll(async () => (await manageWorkflow({ action: "status", id })).json(), {
          timeout: 15_000,
        })
        .toMatchObject({ result: { status: "complete", output: 42 } });
      expect((await manageWorkflow({ action: "delete", id })).status).toBe(200);
    } finally {
      await availability(null);
      await manageWorkflow({ action: "delete", id });
      await manageWorkflow({ action: "delete", id: terminated });
    }
  }, 40_000);

  it("rejects Workflow starts with invalid availability or missing and mismatched org routing", async () => {
    try {
      await availability("invalid-json");
      await rejectedWorkflow(
        await workflowBinding({ method: "create", options: { id: crypto.randomUUID() } }),
        "Organization availability could not be read",
      );
      await availability(null);
      await publishRoute(null);
      await rejectedWorkflow(
        await manageWorkflow({ action: "create", id: crypto.randomUUID() }),
        "Workflow app organization is not published",
      );
      await publishRoute(
        JSON.stringify({
          organizationId: "widefleet",
          appId: preview.appId,
          access: { revision: 1, groups: [] },
        }),
      );
      await rejectedWorkflow(
        await workflowBinding({ method: "create", options: { id: crypto.randomUUID() } }),
        "Workflow app authorization is being updated",
      );
    } finally {
      await availability(null);
      await publish(app);
    }
  });

  it.each([null, '{"blocked":true}', "invalid-json"])(
    "reads an incomplete Workflow creation without starting it with availability %s",
    async (value) => {
      const id = crypto.randomUUID();
      const existing = crypto.randomUUID();
      expect(
        (await manageWorkflow({ action: "create", id: existing, params: { mode: "sleep" } }))
          .status,
      ).toBe(200);
      expect((await workflowBinding({ method: "seedPending", id })).status).toBe(200);
      await availability(value);

      try {
        expect(await (await workflowBinding({ method: "get", id })).json()).toEqual({ id });
        const status = { status: "unknown", error: { name: "WorkflowInstanceUnavailable" } };
        expect(
          await (await workflowBinding({ method: "instance", id, action: "status" })).json(),
        ).toMatchObject(status);
        expect(await (await manageWorkflow({ action: "status", id })).json()).toMatchObject({
          result: status,
        });

        const listed = z
          .object({
            result: z.object({
              instances: z.array(
                z.object({
                  id: z.string(),
                  version: z.string(),
                  createdAt: z.string(),
                  status: z.string(),
                  error: z.object({ name: z.string(), message: z.string() }).optional(),
                }),
              ),
            }),
          })
          .parse(await (await manageWorkflow({ action: "list" })).json());

        const incomplete = listed.result.instances.find((entry) => entry.id === id);
        expect(incomplete).toMatchObject({ id, ...status });
        expect(incomplete?.error?.message).toContain("creation was not confirmed");
        expect(listed.result.instances.map((entry) => entry.id)).toContain(existing);
        expect(await (await workflowBinding({ method: "nativeExists", id })).json()).toBe(false);
        expect((await workflowBinding({ method: "instance", id, action: "delete" })).status).toBe(
          200,
        );
        await availability(null);
        expect(
          await (
            await workflowBinding({ method: "create", options: { id, params: { mode: "sleep" } } })
          ).json(),
        ).toEqual({ id });
      } finally {
        await availability(null);
        await manageWorkflow({ action: "delete", id });
        await manageWorkflow({ action: "delete", id: existing });
      }
    },
  );

  it.each(["pause", "sendEvent", "terminate", "resume", "restart"])(
    "does not create a missing native instance for %s",
    async (action) => {
      const id = crypto.randomUUID();
      expect((await workflowBinding({ method: "seedPending", id })).status).toBe(200);

      try {
        const request =
          action === "sendEvent"
            ? { action, id, event: { type: "continue", payload: { add: 21 } } }
            : { action, id };

        expect((await manageWorkflow(request)).status).toBe(400);
        expect(await (await workflowBinding({ method: "nativeExists", id })).json()).toBe(false);
      } finally {
        await manageWorkflow({ action: "delete", id });
      }
    },
  );

  it.each(["binding", "management"])(
    "does not retry a failed %s creation when inspecting or creating the same ID",
    async (source) => {
      const id = crypto.randomUUID();

      const create = () =>
        source === "binding"
          ? workflowBinding({ method: "create", options: { id, params: { mode: "sleep" } } })
          : manageWorkflow({ action: "create", id, params: { mode: "sleep" } });

      await workflowBinding({ method: "creationFault", options: "before" });

      try {
        await rejectedWorkflow(await create(), "Synthetic Workflow creation failure");
        await workflowBinding({ method: "creationFault", options: null });
        expect((await workflowBinding({ method: "get", id })).status).toBe(200);
        expect(await (await manageWorkflow({ action: "status", id })).json()).toMatchObject({
          result: { status: "unknown" },
        });
        expect((await manageWorkflow({ action: "list" })).status).toBe(200);
        await rejectedWorkflow(await create(), "Workflow instance already exists");
        expect(await (await workflowBinding({ method: "nativeExists", id })).json()).toBe(false);
        expect((await manageWorkflow({ action: "delete", id })).status).toBe(200);
        expect((await create()).status).toBe(200);
      } finally {
        await workflowBinding({ method: "creationFault", options: null });
        await manageWorkflow({ action: "delete", id });
      }
    },
  );

  it.each(["binding", "management", "batch"])(
    "confirms a successful %s creation without a native lookup",
    async (source) => {
      const id = crypto.randomUUID();
      const options = { id, params: { mode: "sleep" } };
      await workflowBinding({ method: "creationFault", options: "lookup" });

      try {
        let response;

        if (source === "binding") response = await workflowBinding({ method: "create", options });
        else if (source === "batch")
          response = await workflowBinding({ method: "createBatch", options: [options] });
        else response = await manageWorkflow({ action: "create", ...options });

        expect(response.status).toBe(200);

        if (source === "binding") expect(await response.json()).toEqual({ id });
        else if (source === "batch") expect(await response.json()).toEqual([{ id }]);
        else expect(await response.json()).toEqual({ result: { id } });

        await rejectedWorkflow(
          await manageWorkflow({ action: "status", id }),
          "Synthetic Workflow lookup failure",
        );
        await workflowBinding({ method: "creationFault", options: null });
        expect((await manageWorkflow({ action: "status", id })).status).toBe(200);
      } finally {
        await workflowBinding({ method: "creationFault", options: null });
        await manageWorkflow({ action: "delete", id });
      }
    },
  );

  it("finds the native instance after a creation response failure", async () => {
    const id = crypto.randomUUID();
    await workflowBinding({ method: "creationFault", options: "after" });

    try {
      expect(
        await (await manageWorkflow({ action: "create", id, params: { mode: "sleep" } })).json(),
      ).toEqual({ result: { id } });
      expect(await (await workflowBinding({ method: "nativeExists", id })).json()).toBe(true);
      await availability('{"blocked":true}');
      expect((await manageWorkflow({ action: "status", id })).status).toBe(200);
    } finally {
      await availability(null);
      await workflowBinding({ method: "creationFault", options: null });
      await manageWorkflow({ action: "delete", id });
    }
  });

  it("allows another organization's Workflow starts during an org suspension", async () => {
    const id = crypto.randomUUID();
    await separatePreviewOrganization();
    await availability(JSON.stringify({ blocked: true }));

    try {
      expect(
        (
          await workflowBinding(
            { method: "create", options: { id, params: { mode: "sleep" } } },
            preview,
          )
        ).status,
      ).toBe(200);
    } finally {
      await availability(null);
      await manageWorkflow({ action: "delete", id }, crypto.randomUUID(), preview);
      await publish(preview);
    }
  });

  it.each(["get", "status", "list", "sendEvent", "pause", "terminate"])(
    "keeps %s available after native creation outlives its catalog confirmation",
    async (action) => {
      const id = crypto.randomUUID();
      expect((await manageWorkflow({ action: "create", id, params: { value: 20 } })).status).toBe(
        200,
      );
      await expect.poll(() => json("/workflow/steps"), { timeout: 15_000 }).toContainEqual({ id });
      expect((await workflowBinding({ method: "forgetStart", id })).status).toBe(200);
      await availability(JSON.stringify({ blocked: true }));

      try {
        const response =
          action === "get"
            ? await workflowBinding({ method: "get", id })
            : await manageWorkflow(
                action === "list"
                  ? { action }
                  : action === "sendEvent"
                    ? { action, id, event: { type: "continue", payload: { add: 21 } } }
                    : { action, id },
              );

        expect(response.status, await response.text()).toBe(200);
      } finally {
        await availability(null);
        await manageWorkflow({ action: "delete", id });
      }
    },
    30_000,
  );

  it.each(["blocked", "error"])(
    "does not repeat management admission after reserving the request ID (%s)",
    async (mode) => {
      const id = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const request = { action: "create", id, params: { mode: "sleep" } };
      expect((await workflowBinding({ method: "admissionFault", options: mode })).status).toBe(200);

      try {
        const response = await manageWorkflow(request, requestId);
        expect(response.status, await response.text()).toBe(200);
        expect(await (await workflowBinding({ method: "admissionReads" })).json()).toBe(1);
        // The same request returns its completed result without a second admission.
        expect(await (await manageWorkflow(request, requestId)).json()).toEqual({ result: { id } });
        expect(await (await workflowBinding({ method: "admissionReads" })).json()).toBe(1);
      } finally {
        await workflowBinding({ method: "admissionFault", options: null });
        await manageWorkflow({ action: "delete", id });
      }
    },
  );

  it.each(["create", "resume", "restart"])(
    "lets management %s reuse its request ID after an availability read failure",
    async (action) => {
      const id = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const params = { value: 20 };
      const request = action === "create" ? { action, id, params } : { action, id };

      if (action !== "create") {
        expect((await manageWorkflow({ action: "create", id, params })).status).toBe(200);
        await expect
          .poll(() => json("/workflow/steps"), { timeout: 15_000 })
          .toEqual(expect.arrayContaining([{ id }]));

        if (action === "resume")
          expect((await manageWorkflow({ action: "pause", id })).status).toBe(200);
      }

      await availability("invalid-json");

      try {
        await rejectedWorkflow(
          await manageWorkflow(request, requestId),
          "Organization availability could not be read",
        );
        await availability(null);
        const expected = { result: action === "create" ? { id } : null };
        expect(await (await manageWorkflow(request, requestId)).json()).toEqual(expected);
        expect(await (await manageWorkflow(request, requestId)).json()).toEqual(expected);
      } finally {
        await availability(null);
        await manageWorkflow({ action: "delete", id });
      }
    },
    30_000,
  );
});
