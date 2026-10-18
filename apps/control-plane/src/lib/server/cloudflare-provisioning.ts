import { createHash } from "node:crypto";
import type * as contract from "@platform/contracts";
import { z } from "zod";

import { CloudflareApiError, cloudflareCall, createCloudflareClient } from "./cloudflare-client.ts";

export { CloudflareApiError } from "./cloudflare-client.ts";

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

export const createCloudflareProvisioner = (
  configuration: { accountId: string; token: string; runtimeName: string },
  transport: typeof fetch = fetch,
) => {
  const client = createCloudflareClient(configuration.token, transport);
  const account = { account_id: configuration.accountId };
  const call = cloudflareCall;

  const findDatabase = (name: string) =>
    call("list D1 databases", async () => {
      for await (const entry of client.d1.database.list({
        ...account,
        name,
        page: 1,
        per_page: 100,
      }))
        if (entry.name === name) return database.parse(entry).uuid;

      return null;
    });

  const findNamespace = (title: string) =>
    call("list KV namespaces", async () => {
      for await (const entry of client.kv.namespaces.list({ ...account, page: 1, per_page: 100 }))
        if (entry.title === title) return namespace.parse(entry).id;

      return null;
    });

  const ensureDatabase = async (name: string) => {
    const existing = await findDatabase(name);

    if (existing) return existing;

    const created = database.parse(
      await call("create D1 database", () => client.d1.database.create({ ...account, name })),
    );

    if (created.name !== name) throw new Error("Cloudflare returned an unexpected database");

    return created.uuid;
  };

  const ensureBucket = async (name: string) => {
    try {
      const existing = bucket.parse(
        await call("get R2 bucket", () => client.r2.buckets.get(name, account)),
      );

      if (existing.name !== name) throw new Error("Cloudflare returned an unexpected bucket");
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;

      const created = bucket.parse(
        await call("create R2 bucket", () => client.r2.buckets.create({ ...account, name })),
      );

      if (created.name !== name) throw new Error("Cloudflare returned an unexpected bucket");
    }
  };

  const ensureNamespace = async (title: string) => {
    const existing = await findNamespace(title);

    if (existing) return existing;

    const created = namespace.parse(
      await call("create KV namespace", () => client.kv.namespaces.create({ ...account, title })),
    );

    if (created.title !== title) throw new Error("Cloudflare returned an unexpected namespace");

    return created.id;
  };

  // The SDK models queues as SinglePage and omits page parameters (cloudflare 7.3).
  // Keep paging explicitly until that endpoint supports automatic iteration.
  const findQueue = (name: string) =>
    call("list queues", async () => {
      for (let page = 1; ; page++) {
        const found = await client.queues.list(account, { query: { page, per_page: 100 } });
        const existing = found.result.find((entry) => entry.queue_name === name);

        if (existing) return queue.parse(existing);

        if (found.result.length < 100) return null;
      }
    });

  const ensureQueue = async (name: string) => {
    const existing = await findQueue(name);

    if (existing) return existing;

    const created = queue.parse(
      await call("create queue", () => client.queues.create({ ...account, queue_name: name })),
    );

    if (created.queue_name !== name) throw new Error("Cloudflare returned an unexpected queue");

    return created;
  };

  return {
    findDatabase,
    findQueue,
    ensureDatabase,
    ensureBucket,
    ensureNamespace,
    ensureQueue,
    client,
    account,
    call,
    findNamespace,
    scope: `${configuration.accountId}/${configuration.runtimeName}`,
    readBindings: async () =>
      workerBindings.parse(
        await call("read Worker bindings", () =>
          client.workers.scripts.scriptAndVersionSettings.get(configuration.runtimeName, account),
        ),
      ),
    writeBindings: async (
      id: string,
      retained: string[],
      resources: z.infer<typeof cloudflareResource>[],
    ) => {
      const settings = {
        annotations: { "workers/tag": id },
        bindings: [
          // Inheritance preserves secrets, native bindings and retained app versions.
          ...retained.map((name) => ({ name, type: "inherit" as const })),
          ...resources,
        ],
      };

      await call("update Worker bindings", () =>
        client.workers.scripts.scriptAndVersionSettings.edit(
          configuration.runtimeName,
          account,
          // The SDK flattens objects into form fields; this API requires a JSON part.
          { body: { settings: JSON.stringify(settings) } },
        ),
      );
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
          resources.push({ type: "d1", name: native, id: await ensureDatabase(name) });
        } else if (binding.type === "r2_bucket") {
          await ensureBucket(name);
          resources.push({ type: "r2_bucket", name: native, bucket_name: name });
        } else if (binding.type === "kv_namespace") {
          resources.push({
            type: "kv_namespace",
            name: native,
            namespace_id: await ensureNamespace(name),
          });
        } else {
          await ensureQueue(name);
          resources.push({ type: "queue", name: native, queue_name: name });
        }
      }

      for (const consumer of app.metadata.queue_consumers) {
        await ensureQueue(cloudflareResourceName(app.appId, "queue", consumer.queue));

        if (consumer.dead_letter_queue)
          await ensureQueue(cloudflareResourceName(app.appId, "queue", consumer.dead_letter_queue));
      }

      return { nativeBindings, resources };
    },
  };
};
