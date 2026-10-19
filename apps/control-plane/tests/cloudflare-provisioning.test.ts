import { describe, expect, it } from "vitest";
import { workerMetadata } from "@platform/contracts";
import { createCloudflareProvisioner } from "../src/lib/server/cloudflare-provisioning.ts";
import { z } from "zod";

const fixture = () => {
  const databases = new Map<string, string>();
  const buckets = new Set<string>();
  const namespaces = new Map<string, string>();
  const queues = new Map<string, string>();
  const patches: unknown[] = [];
  let loseResponse = false;
  let failCreation = false;

  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");

    const ok = (result: z.infer<ReturnType<typeof z.json>>) =>
      Response.json({ success: true, result });

    if (request.method === "POST" && failCreation) {
      failCreation = false;

      return new Response(null, { status: 503 });
    }

    if (url.pathname.endsWith("/d1/database")) {
      if (request.method === "GET")
        return ok(
          [...databases]
            .map(([name, uuid]) => ({ name, uuid }))
            .slice(
              (Number(url.searchParams.get("page") ?? 1) - 1) * 100,
              Number(url.searchParams.get("page") ?? 1) * 100,
            ),
        );
      const { name } = z.object({ name: z.string() }).parse(await request.json());
      const uuid = crypto.randomUUID();
      expect(databases.has(name)).toBe(false);
      databases.set(name, uuid);

      if (loseResponse) {
        loseResponse = false;
        throw new Error("Lost creation response");
      }

      return ok({ uuid, name });
    }

    if (url.pathname.endsWith("/storage/kv/namespaces")) {
      if (request.method === "GET")
        return ok(
          [...namespaces]
            .map(([title, id]) => ({ title, id }))
            .slice(
              (Number(url.searchParams.get("page") ?? 1) - 1) * 100,
              Number(url.searchParams.get("page") ?? 1) * 100,
            ),
        );
      const { title } = z.object({ title: z.string() }).parse(await request.json());
      expect(namespaces.has(title)).toBe(false);
      const id = crypto.randomUUID();
      namespaces.set(title, id);

      if (loseResponse) {
        loseResponse = false;
        throw new Error("Lost creation response");
      }

      return ok({ title, id });
    }

    if (url.pathname.endsWith("/queues")) {
      if (request.method === "GET")
        return ok([...queues].map(([queue_name, queue_id]) => ({ queue_name, queue_id })));
      const { queue_name } = z.object({ queue_name: z.string() }).parse(await request.json());
      expect(queues.has(queue_name)).toBe(false);
      const queue_id = crypto.randomUUID();
      queues.set(queue_name, queue_id);

      if (loseResponse) {
        loseResponse = false;
        throw new Error("Lost creation response");
      }

      return ok({ queue_name, queue_id });
    }

    if (url.pathname.endsWith("/r2/buckets")) {
      const { name } = z.object({ name: z.string() }).parse(await request.json());
      expect(buckets.has(name)).toBe(false);
      buckets.add(name);

      if (loseResponse) {
        loseResponse = false;
        throw new Error("Lost creation response");
      }

      return ok({ name });
    }

    if (url.pathname.includes("/r2/buckets/")) {
      const name = url.pathname.split("/").at(-1);

      return name && buckets.has(name) ? ok({ name }) : new Response(null, { status: 404 });
    }

    if (url.pathname.endsWith("/settings")) {
      if (request.method === "GET")
        return ok({
          bindings: [
            { name: "PLATFORM_SECRET", type: "secret_text" },
            { name: "OLD_APP_DB", type: "d1" },
          ],
        });
      const data = await request.formData();
      patches.push(JSON.parse(z.string().parse(data.get("settings"))));

      return ok({});
    }

    throw new Error("Unexpected provisioning request");
  };

  const create = () =>
    createCloudflareProvisioner(
      { accountId: "0".repeat(32), token: "fixture-token", runtimeName: "fixture-runtime" },
      transport,
    );

  return {
    create,
    databases,
    buckets,
    namespaces,
    queues,
    patches,
    loseNextResponse: () => {
      loseResponse = true;
    },
    failNextCreation: () => {
      failCreation = true;
    },
  };
};

const app = () => ({
  appId: crypto.randomUUID(),
  metadata: workerMetadata.parse({
    main_module: "app.js",
    compatibility_date: "2026-10-01",
    assets: { upload_session: crypto.randomUUID() },
    bindings: [
      { type: "d1", name: "DB", database_name: "data" },
      { type: "r2_bucket", name: "FILES", bucket_name: "files" },
    ],
  }),
});

describe("Cloudflare app provisioning", () => {
  it.each(["d1", "kv", "queue"])(
    "finds an existing %s resource beyond the first page",
    async (kind) => {
      const pages: number[] = [];
      const id = crypto.randomUUID();

      const provisioner = createCloudflareProvisioner(
        { accountId: "0".repeat(32), token: "fixture-token", runtimeName: "fixture" },
        async (input, init) => {
          const request = new Request(input, init);
          expect(request.method).toBe("GET");
          const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
          pages.push(page);

          const names =
            page === 1 ? Array.from({ length: 100 }, (_, index) => `other-${index}`) : ["owned"];

          return Response.json({
            success: true,
            result: names.map((name) =>
              kind === "d1"
                ? { name, uuid: id }
                : kind === "kv"
                  ? { title: name, id }
                  : { queue_name: name, queue_id: id },
            ),
          });
        },
      );

      if (kind === "d1") expect(await provisioner.ensureDatabase("owned")).toBe(id);
      else if (kind === "kv") expect(await provisioner.ensureNamespace("owned")).toBe(id);
      else expect((await provisioner.ensureQueue("owned")).queue_id).toBe(id);
      expect(pages).toEqual([1, 2]);
    },
  );

  it.each([
    { type: "d1", name: "RESOURCE", database_name: "data" },
    { type: "r2_bucket", name: "RESOURCE", bucket_name: "files" },
    { type: "kv_namespace", name: "RESOURCE", id: "cache" },
    { type: "queue", name: "RESOURCE", queue: "jobs" },
  ])("retries $type creation that failed without creating a resource", async (binding) => {
    const cloud = fixture();
    const deployment = app();
    deployment.metadata = workerMetadata.parse({ ...deployment.metadata, bindings: [binding] });
    cloud.failNextCreation();
    await expect(cloud.create().provision(deployment)).rejects.toThrow("HTTP 503");
    expect(
      cloud.databases.size + cloud.buckets.size + cloud.namespaces.size + cloud.queues.size,
    ).toBe(0);

    const prepared = await cloud.create().provision(deployment);
    expect(prepared.resources).toHaveLength(1);
    expect(await cloud.create().provision(deployment)).toEqual(prepared);
    expect(
      cloud.databases.size + cloud.buckets.size + cloud.namespaces.size + cloud.queues.size,
    ).toBe(1);
  });

  it("recovers a lost R2 bucket creation response", async () => {
    const cloud = fixture();
    const deployment = app();
    deployment.metadata = workerMetadata.parse({
      ...deployment.metadata,
      bindings: [{ type: "r2_bucket", name: "FILES", bucket_name: "files" }],
    });
    cloud.loseNextResponse();
    await expect(cloud.create().provision(deployment)).rejects.toThrow("connection error");
    expect((await cloud.create().provision(deployment)).resources).toHaveLength(1);
    expect(cloud.buckets.size).toBe(1);
  });

  it("recovers from a lost creation response without allocating a second resource", async () => {
    const cloud = fixture();
    const deployment = app();
    cloud.loseNextResponse();
    await expect(cloud.create().provision(deployment)).rejects.toThrow("connection error");
    const prepared = await cloud.create().provision(deployment);
    expect(await cloud.create().provision(deployment)).toEqual(prepared);
    const bindings = prepared.nativeBindings;
    const current = await cloud.create().readBindings();
    const id = crypto.randomUUID();
    await cloud.create().writeBindings(
      id,
      current.bindings.map((binding) => binding.name),
      prepared.resources,
    );
    expect(cloud.patches[0]).toMatchObject({ annotations: { "workers/tag": id } });
    expect(cloud.databases.size).toBe(1);
    expect(cloud.buckets.size).toBe(1);
    const patch = z.object({ bindings: z.array(z.unknown()) }).parse(cloud.patches.at(-1));
    expect(patch.bindings).toContainEqual({ name: "PLATFORM_SECRET", type: "inherit" });
    expect(patch.bindings).toContainEqual({ name: "OLD_APP_DB", type: "inherit" });
    expect(patch.bindings).toContainEqual({
      name: bindings["DB"],
      type: "d1",
      id: [...cloud.databases.values()][0],
    });
    expect(patch.bindings).toContainEqual({
      name: bindings["FILES"],
      type: "r2_bucket",
      bucket_name: [...cloud.buckets][0],
    });
  });

  it("isolates identically named resources belonging to different apps", async () => {
    const cloud = fixture();
    const first = app();
    const second = { ...first, appId: crypto.randomUUID() };
    expect(await cloud.create().provision(first)).not.toEqual(
      await cloud.create().provision(second),
    );
    expect(cloud.databases.size).toBe(2);
    expect(cloud.buckets.size).toBe(2);
  });

  it.each(["kv", "queue"])(
    "recovers a lost %s creation response and keeps preview resources separate",
    async (kind) => {
      const cloud = fixture();
      const deployment = app();
      deployment.metadata = workerMetadata.parse({
        ...deployment.metadata,
        bindings:
          kind === "kv"
            ? [{ type: "kv_namespace", name: "STORE", id: "cache" }]
            : [{ type: "queue", name: "STORE", queue: "jobs" }],
        queue_consumers: kind === "queue" ? [{ queue: "jobs", dead_letter_queue: "failed" }] : [],
      });
      cloud.loseNextResponse();
      await expect(cloud.create().provision(deployment)).rejects.toThrow("connection error");
      const result = await cloud.create().provision(deployment);
      expect(await cloud.create().provision(deployment)).toEqual(result);
      expect(result.resources).toHaveLength(1);
      const preview = await cloud.create().provision({ ...deployment, appId: crypto.randomUUID() });
      expect(preview.nativeBindings).not.toEqual(result.nativeBindings);
      expect(cloud.namespaces.size).toBe(kind === "kv" ? 2 : 0);
      expect(cloud.queues.size).toBe(kind === "queue" ? 4 : 0);
    },
  );

  it("creates consumer-only queues and shares duplicate producer references", async () => {
    const cloud = fixture();
    const deployment = app();
    deployment.metadata = workerMetadata.parse({
      ...deployment.metadata,
      bindings: [
        { type: "queue", name: "A", queue: "jobs" },
        { type: "queue", name: "B", queue: "jobs" },
        { type: "workflow", name: "FLOW", workflow_name: "flow", class_name: "Flow" },
      ],
      queue_consumers: [{ queue: "other", dead_letter_queue: "failed" }],
    });
    const result = await cloud.create().provision(deployment);
    expect(result.nativeBindings["A"]).toBe(result.nativeBindings["B"]);
    expect(result.resources).toHaveLength(1);
    expect(result.nativeBindings).not.toHaveProperty("FLOW");
    expect(cloud.queues.size).toBe(3);
  });

  it("redacts upstream credentials and does not treat failed lookups as missing resources", async () => {
    let requests = 0;

    const provisioner = createCloudflareProvisioner(
      { accountId: "0".repeat(32), token: "fixture-token", runtimeName: "fixture" },
      async () => {
        requests++;

        return Response.json(
          { errors: [{ code: 10000, message: "sensitive upstream credentials" }] },
          { status: 403 },
        );
      },
    );

    await expect(provisioner.provision(app())).rejects.toThrow(
      "Cloudflare list D1 databases failed (HTTP 403; codes 10000)",
    );
    expect(requests).toBe(1);
  });
});
