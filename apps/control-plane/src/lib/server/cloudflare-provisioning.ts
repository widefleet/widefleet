import { createHash } from "node:crypto";
import type * as contract from "@platform/contracts";
import type {
  CloudflareResourceCreator,
  CloudflareResourceKind,
} from "./cloudflare-resource-creations.ts";
import { z } from "zod";

const envelope = z.object({ success: z.boolean(), result: z.unknown().optional() });

const database = z.object({ uuid: z.uuid(), name: z.string() });

const bucket = z.object({ name: z.string() });

const namespace = z.object({ id: z.string(), title: z.string() });

const queue = z.object({ queue_id: z.string(), queue_name: z.string() });

export const cloudflareResourceName = (appId: string, kind: string, name: string) =>
  `r${createHash("sha256").update(`${appId}/${kind}/${name}`).digest("hex").slice(0, 40)}`;

const workerBindings = z.object({
  annotations: z.object({ "workers/tag": z.string().optional() }).optional(),
  bindings: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      id: z.string().optional(),
      database_id: z.string().optional(),
      bucket_name: z.string().optional(),
      jurisdiction: z.string().optional(),
      namespace_id: z.string().optional(),
      queue_name: z.string().optional(),
      service: z.string().optional(),
      entrypoint: z.string().optional(),
    }),
  ),
});

export const cloudflareResource = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("service"),
    name: z.string(),
    service: z.string(),
    entrypoint: z.string(),
  }),
  z.object({ type: z.literal("d1"), name: z.string(), id: z.string() }),
  z.object({ type: z.literal("r2_bucket"), name: z.string(), bucket_name: z.string() }),
  z.object({ type: z.literal("kv_namespace"), name: z.string(), namespace_id: z.string() }),
  z.object({ type: z.literal("queue"), name: z.string(), queue_name: z.string() }),
]);

export class CloudflareApiError extends Error {
  constructor(readonly status: number) {
    // Upstream bodies can contain configuration and credentials. Keep them out of job logs.
    super(`Cloudflare provisioning request failed (HTTP ${status})`);
    this.name = "CloudflareApiError";
  }
}

export const createCloudflareProvisioner = (
  configuration: { accountId: string; token: string; runtimeName: string },
  transport: typeof fetch = fetch,
  trackCreation?: CloudflareResourceCreator,
) => {
  const root = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`;

  const request = async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${configuration.token}`);

    const response = await transport(`${root}${path}`, {
      ...options,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new CloudflareApiError(response.status);
    }

    if (response.status === 204) return undefined;
    const body = envelope.parse(await response.json());

    if (!body.success) throw new CloudflareApiError(response.status);

    return body.result;
  };

  const findDatabase = async (name: string) => {
    for (let page = 1; ; page++) {
      const found = z
        .array(database)
        .parse(
          await request(`/d1/database?name=${encodeURIComponent(name)}&page=${page}&per_page=100`),
        );

      const match = found.find((entry) => entry.name === name);

      if (match) return match.uuid;

      if (found.length < 100) return null;
    }
  };

  const ensure = async <T>(
    appId: string | undefined,
    kind: CloudflareResourceKind,
    name: string,
    read: () => Promise<T | null>,
    create: () => Promise<T>,
  ) => {
    if (appId && trackCreation) return trackCreation(appId, kind, name, read, create);

    return (await read()) ?? create();
  };

  const ensureDatabase = (name: string, appId?: string) =>
    ensure(
      appId,
      "d1",
      name,
      () => findDatabase(name),
      async () => {
        const created = database.parse(
          await request("/d1/database", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          }),
        );

        if (created.name !== name) throw new Error("Cloudflare returned an unexpected database");

        return created.uuid;
      },
    );

  const findBucket = async (name: string) => {
    try {
      const existing = bucket.parse(await request(`/r2/buckets/${encodeURIComponent(name)}`));

      if (existing.name !== name) throw new Error("Cloudflare returned an unexpected bucket");

      return existing.name;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return null;
      throw error;
    }
  };

  const ensureBucket = (name: string, appId?: string) =>
    ensure(
      appId,
      "r2",
      name,
      () => findBucket(name),
      async () => {
        const created = bucket.parse(
          await request("/r2/buckets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          }),
        );

        if (created.name !== name) throw new Error("Cloudflare returned an unexpected bucket");

        return created.name;
      },
    );

  const findNamespace = async (title: string) => {
    for (let page = 1; ; page++) {
      const found = z
        .array(namespace)
        .parse(await request(`/storage/kv/namespaces?page=${page}&per_page=100`));

      const existing = found.find((entry) => entry.title === title);

      if (existing) return existing.id;

      if (found.length < 100) return null;
    }
  };

  const ensureNamespace = (title: string, appId?: string) =>
    ensure(
      appId,
      "kv",
      title,
      () => findNamespace(title),
      async () => {
        const created = namespace.parse(
          await request("/storage/kv/namespaces", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title }),
          }),
        );

        if (created.title !== title) throw new Error("Cloudflare returned an unexpected namespace");

        return created.id;
      },
    );

  const findQueue = async (name: string) => {
    for (let page = 1; ; page++) {
      const found = z.array(queue).parse(await request(`/queues?page=${page}&per_page=100`));

      const existing = found.find((entry) => entry.queue_name === name);

      if (existing) return existing;

      if (found.length < 100) return null;
    }
  };

  const ensureQueue = (name: string, appId?: string) =>
    ensure(
      appId,
      "queue",
      name,
      () => findQueue(name),
      async () => {
        const created = queue.parse(
          await request("/queues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ queue_name: name }),
          }),
        );

        if (created.queue_name !== name) throw new Error("Cloudflare returned an unexpected queue");

        return created;
      },
    );

  return {
    findResource: async (kind: CloudflareResourceKind, name: string) => {
      switch (kind) {
        case "d1":
          return (await findDatabase(name)) !== null;
        case "r2":
          return (await findBucket(name)) !== null;
        case "kv":
          return (await findNamespace(name)) !== null;
        case "queue":
          return (await findQueue(name)) !== null;
      }
    },
    findDatabase,
    findQueue,
    ensureDatabase,
    ensureBucket,
    ensureNamespace,
    ensureQueue,
    request,
    scope: `${configuration.accountId}/${configuration.runtimeName}`,
    readBindings: async () =>
      workerBindings.parse(
        await request(`/workers/scripts/${encodeURIComponent(configuration.runtimeName)}/settings`),
      ),
    writeBindings: async (
      id: string,
      retained: string[],
      resources: z.infer<typeof cloudflareResource>[],
    ) => {
      const settings = new FormData();
      settings.set(
        "settings",
        JSON.stringify({
          annotations: { "workers/tag": id },
          bindings: [
            // Inheritance preserves secrets, native bindings and retained app versions.
            ...retained.map((name) => ({ name, type: "inherit" })),
            ...resources,
          ],
        }),
      );
      await request(`/workers/scripts/${encodeURIComponent(configuration.runtimeName)}/settings`, {
        method: "PATCH",
        body: settings,
      });
    },
    provision: async (app: Pick<z.infer<typeof contract.artifact>, "appId" | "metadata">) => {
      const nativeBindings: Record<string, string> = {};
      const resources: z.infer<typeof cloudflareResource>[] = [];

      for (const binding of app.metadata.bindings) {
        if (binding.type === "plain_text" || binding.type === "workflow") continue;

        const kind = { d1: "d1", r2_bucket: "r2", kv_namespace: "kv", queue: "queue" }[
          binding.type
        ];

        const logicalName =
          binding.type === "d1"
            ? (binding.database_id ?? binding.database_name)
            : binding.type === "r2_bucket"
              ? binding.bucket_name
              : binding.type === "kv_namespace"
                ? binding.id
                : binding.queue;

        // App IDs isolate production and previews; names remain stable across retries.
        const name = cloudflareResourceName(app.appId, kind, logicalName);
        const native = `B_${name}`;
        nativeBindings[binding.name] = native;

        if (resources.some((resource) => resource.name === native)) continue;

        if (binding.type === "d1") {
          resources.push({ type: "d1", name: native, id: await ensureDatabase(name, app.appId) });
        } else if (binding.type === "r2_bucket") {
          await ensureBucket(name, app.appId);
          resources.push({ type: "r2_bucket", name: native, bucket_name: name });
        } else if (binding.type === "kv_namespace") {
          resources.push({
            type: "kv_namespace",
            name: native,
            namespace_id: await ensureNamespace(name, app.appId),
          });
        } else {
          await ensureQueue(name, app.appId);
          resources.push({ type: "queue", name: native, queue_name: name });
        }
      }

      for (const consumer of app.metadata.queue_consumers) {
        await ensureQueue(cloudflareResourceName(app.appId, "queue", consumer.queue), app.appId);

        if (consumer.dead_letter_queue)
          await ensureQueue(
            cloudflareResourceName(app.appId, "queue", consumer.dead_letter_queue),
            app.appId,
          );
      }

      return { nativeBindings, resources };
    },
  };
};
