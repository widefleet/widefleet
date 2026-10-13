import type { R2Bucket, R2ListOptions } from "@cloudflare/workers-types";
import type { ObjectStorage } from "../artifact-storage.ts";

export const createR2Storage = (bucket: R2Bucket) =>
  ({
    put: async (key: string, bytes: Uint8Array, contentType: string) => {
      await bucket.put(key, Uint8Array.from(bytes).buffer, {
        httpMetadata: { contentType },
        onlyIf: { etagDoesNotMatch: "*" },
      });
    },
    get: async (key: string) => {
      const object = await bucket.get(key);

      if (!object) throw new Error("Artifact not found");

      return new Uint8Array(await object.arrayBuffer());
    },
    exists: async (key: string) => (await bucket.head(key)) !== null,
    async *list(prefix: string) {
      let cursor: string | undefined;

      do {
        const options: R2ListOptions = { prefix };

        if (cursor !== undefined) options.cursor = cursor;
        const page = await bucket.list(options);

        for (const object of page.objects) yield { key: object.key, size: object.size };

        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    },
    remove: (keys: string[]) => bucket.delete(keys),
  }) satisfies ObjectStorage;
