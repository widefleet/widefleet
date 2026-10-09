import { Result } from "better-result";
import { StorageUnavailable } from "./errors.ts";
import { createAzureStorage } from "./storage/azure.ts";
import type { StorageConfiguration } from "./storage/config.ts";
import { createGcsStorage } from "./storage/gcs.ts";
import { createS3Storage } from "./storage/s3.ts";

const createObjectStorage = (configuration: StorageConfiguration) => {
  switch (configuration.ARTIFACT_STORAGE_PROVIDER) {
    case "s3":
      return createS3Storage(configuration);
    case "azure":
      return createAzureStorage(configuration);
    case "gcs":
      return createGcsStorage(configuration);
  }
};

export const createStorage = (
  configuration: StorageConfiguration,
  store = createObjectStorage(configuration),
) => ({
  // Create immutable content or preserve the existing object. Retrying a write must be safe
  // even when a previous upload succeeded but its database transaction rolled back.
  put: (key: string, bytes: Uint8Array, contentType: string) =>
    Result.tryPromise({
      try: () => store.put(key, bytes, contentType),
      catch: (cause) => new StorageUnavailable({ message: "Artifact upload failed", cause }),
    }),
  get: (key: string) =>
    Result.tryPromise({
      try: () => store.get(key),
      catch: (cause) => new StorageUnavailable({ message: "Artifact download failed", cause }),
    }),
  exists: (key: string) =>
    Result.tryPromise({
      try: () => store.exists(key),
      catch: (cause) => new StorageUnavailable({ message: "Artifact lookup failed", cause }),
    }),
  assetInventory: (appId: string) =>
    Result.tryPromise({
      try: async () => {
        const prefix = `apps/${appId}/assets/`;
        const inventory = new Map<string, number>();

        for await (const entry of store.list(prefix))
          inventory.set(entry.key.slice(prefix.length), entry.size);

        return inventory;
      },
      catch: (cause) =>
        new StorageUnavailable({ message: "Could not inspect existing assets", cause }),
    }),
  removeApp: (appId: string) =>
    Result.tryPromise({
      try: async () => {
        // Uploads are blocked before teardown. Re-list after each bounded deletion batch.
        while (true) {
          const keys: string[] = [];

          for await (const entry of store.list(`apps/${appId}/`)) {
            keys.push(entry.key);

            if (keys.length === 1000) break;
          }

          if (keys.length === 0) return;
          await store.remove(keys);
        }
      },
      catch: (cause) => new StorageUnavailable({ message: "Artifact cleanup failed", cause }),
    }),
});

export type ArtifactStorage = ReturnType<typeof createStorage>;
