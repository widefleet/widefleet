import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Unstable_DevWorker } from "wrangler";
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
    capabilities: { CONNECTOR: "CONNECTOR" },
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
    init?: Parameters<Unstable_DevWorker["fetch"]>[1],
    host = hostname,
  ) => worker.fetch(`https://${host}${path}`, init);

  const json = async (
    path: string,
    init?: Parameters<Unstable_DevWorker["fetch"]>[1],
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
        modules: [{ hash: sourceHash, source }],
        assets: [{ hash: assetHash, source: asset }],
      }),
    });

    expect(response.status).toBe(204);
  };

  beforeAll(async () => {
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
        compatibility_flags: ["nodejs_compat"],
        vars: {
          PRIVATE_ROOT_SECRET: "parent-only-fixture",
          WIDEFLEET_CONTROL_TOKEN: "local-test-only",
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
            { name: "WIDEFLEET_WORKFLOW_CATALOG", class_name: "WidefleetWorkflowCatalog" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["WidefleetWorkflowCatalog"] }],
        services: [
          {
            binding: "WIDEFLEET_WORKFLOW_SESSIONS",
            service: "widefleet-runtime-test",
            entrypoint: "CloudflareWorkflowSessions",
          },
          { binding: "CONNECTOR", service: "widefleet-runtime-test", entrypoint: "Connector" },
        ],
        workflows: [
          { binding: "WIDEFLEET_WORKFLOWS", name: "app-workflows", class_name: "AppWorkflow" },
        ],
      }),
    );
    const { unstable_dev } = await import("wrangler");
    worker = await unstable_dev(main, {
      config,
      local: true,
      persist: false,
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

  it("keeps simultaneous workflow sessions separate for the app and preview", async () => {
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
});
