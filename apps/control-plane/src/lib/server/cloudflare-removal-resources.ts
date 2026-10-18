import * as contract from "@platform/contracts";
import { z } from "zod";
import {
  CloudflareApiError,
  cloudflareResourceName,
  type createCloudflareProvisioner,
} from "./cloudflare-provisioning.ts";

export const removalResource = z.object({
  kind: z.enum(["d1", "r2", "kv", "queue"]),
  name: z.string(),
});

export const removalResources = (
  appId: string,
  metadata: z.infer<typeof contract.workerMetadata>[],
) => {
  const resources = new Map<string, z.infer<typeof removalResource>>();

  const add = (kind: z.infer<typeof removalResource>["kind"], logicalName: string) => {
    const name = cloudflareResourceName(appId, kind, logicalName);
    resources.set(name, { kind, name });
  };

  for (const version of metadata) {
    for (const binding of version.bindings) {
      switch (binding.type) {
        case "d1":
          add("d1", binding.database_id ?? binding.database_name);
          break;
        case "r2_bucket":
          add("r2", binding.bucket_name);
          break;
        case "kv_namespace":
          add("kv", binding.id);
          break;
        case "queue":
          add("queue", binding.queue);
          break;
      }
    }

    for (const consumer of version.queue_consumers) {
      add("queue", consumer.queue);

      if (consumer.dead_letter_queue) add("queue", consumer.dead_letter_queue);
    }
  }

  return [...resources.values()];
};

export const removeCloudflareResource = async (
  provisioner: ReturnType<typeof createCloudflareProvisioner>,
  resource: z.infer<typeof removalResource>,
) => {
  const { client, account, call } = provisioner;

  const remove = async (operation: string, run: () => Promise<Response>) => {
    try {
      await call(operation, run);
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
  };

  if (resource.kind === "d1") {
    const id = await provisioner.findDatabase(resource.name);

    if (id)
      await remove("delete D1 database", () => client.d1.database.delete(id, account).asResponse());
  } else if (resource.kind === "queue") {
    const queue = await provisioner.findQueue(resource.name);

    if (queue)
      await remove("delete queue", () =>
        client.queues.delete(queue.queue_id, account).asResponse(),
      );
  } else if (resource.kind === "kv") {
    const id = await provisioner.findNamespace(resource.name);

    if (id)
      await remove("delete KV namespace", () =>
        client.kv.namespaces.delete(id, account).asResponse(),
      );
  } else {
    try {
      // Delete one bounded page per Workflow checkpoint. Always read the first
      // page again: keys have disappeared, so an offset can skip remaining data.
      const objects = z
        .array(z.object({ key: z.string() }))
        .parse(
          (
            await call("list R2 objects", () =>
              client.r2.buckets.objects.list(resource.name, { ...account, per_page: 100 }),
            )
          ).result,
        );

      for (let index = 0; index < objects.length; index += 4)
        await Promise.all(
          objects.slice(index, index + 4).map((object) =>
            remove("delete R2 object", () =>
              client.r2.buckets.objects
                .delete(object.key, {
                  ...account,
                  bucket_name: resource.name,
                })
                .asResponse(),
            ),
          ),
        );

      if (objects.length) return false;
      await remove("delete R2 bucket", () =>
        client.r2.buckets.delete(resource.name, account).asResponse(),
      );
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
  }

  return true;
};
