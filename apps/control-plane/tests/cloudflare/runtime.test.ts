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

  const start = async () => {
    const { unstable_dev } = await import("wrangler");

    return unstable_dev(join(directory, "index.js"), {
      config: join(directory, "wrangler.json"),
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

  it("blocks app HTTP and assets while keeping management and scheduled dispatch available", async () => {
    await publish({ ...app, httpBlocked: true });

    try {
      for (const path of ["/", "/asset.txt"]) {
        const response = await fetchApp(path);
        expect(response.status).toBe(429);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }

      expect(await json("/.well-known/widefleet/ready")).toMatchObject({ version: app.version });
      expect(
        (await fetchApp(`/__scheduled?${new URLSearchParams({ cron: "* * * * *" })}`)).status,
      ).toBe(200);
      expect((await fetchApp("/asset.txt", undefined, previewHostname)).status).toBe(200);
    } finally {
      await publish(app);
    }

    expect((await fetchApp("/asset.txt")).status).toBe(200);
    expect(await json("/cron")).toBe("* * * * *");
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

  it("rechecks connector grants when a pinned workflow resumes", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}&mode=permissions`;
    await json(path, { method: "POST" });
    await json(`${path}&action=pause`, { method: "PUT" });
    await expect.poll(() => json(path), { timeout: 15_000 }).toMatchObject({ status: "paused" });
    await publish(publishedApp.parse({ ...app, version: crypto.randomUUID(), capabilities: {} }));
    await worker.stop();
    worker = await start();

    try {
      await json(path, { method: "PUT" });
      await json(`${path}&action=resume`, { method: "PUT" });
      await expect
        .poll(() => json(path), { timeout: 15_000 })
        .toMatchObject({
          status: "complete",
          output: { connector: false, secret: null },
        });
    } finally {
      await publish(app);
    }
  }, 55_000);

  it("resumes pinned code after a deployment while new instances use the new version", async () => {
    const id = crypto.randomUUID();
    const path = `/workflow?id=${id}`;
    await json(path, { method: "POST" });
    await expect.poll(() => json("/workflow/steps"), { timeout: 15_000 }).toContainEqual({ id });
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
    await worker.stop();
    worker = await start();

    try {
      await json(path, { method: "PUT" });
      await json(`${path}&action=resume`, { method: "PUT" });
      await expect
        .poll(() => json(path), { timeout: 15_000 })
        .toMatchObject({ status: "complete", output: 42 });
      const next = `/workflow?id=${crypto.randomUUID()}`;
      await json(next, { method: "POST" });
      await json(next, { method: "PUT" });
      await expect
        .poll(() => json(next), { timeout: 15_000 })
        .toMatchObject({ status: "complete", output: 142 });
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
});
