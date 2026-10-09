import {
  ApiError,
  Storage,
  type StorageOptions,
  type GetFilesOptions,
} from "@google-cloud/storage";
import { z } from "zod";
import type { StorageConfiguration } from "./config.ts";

type GcsConfiguration = Extract<StorageConfiguration, { ARTIFACT_STORAGE_PROVIDER: "gcs" }>;

export const createGcsClient = (configuration: GcsConfiguration) => {
  const options: StorageOptions = { retryOptions: { maxRetries: 2, totalTimeout: 30 } };

  if (configuration.GOOGLE_APPLICATION_CREDENTIALS !== undefined)
    options.keyFilename = configuration.GOOGLE_APPLICATION_CREDENTIALS;

  return new Storage(options);
};

export const createGcsStorage = (
  configuration: GcsConfiguration,
  client = createGcsClient(configuration),
) => {
  const bucket = client.bucket(configuration.GCS_BUCKET);

  return {
    put: async (key: string, bytes: Uint8Array, contentType: string) => {
      try {
        await bucket.file(key).save(Buffer.from(bytes), {
          contentType,
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
          timeout: 30_000,
        });
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === 412) return;
        throw cause;
      }
    },
    get: async (key: string) => {
      const [bytes] = await bucket.file(key).download();

      return new Uint8Array(bytes);
    },
    exists: async (key: string) => {
      const [exists] = await bucket.file(key).exists();

      return exists;
    },
    async *list(prefix: string) {
      let pageToken: string | undefined;

      do {
        const query: GetFilesOptions = { prefix, autoPaginate: false, maxResults: 1000 };

        if (pageToken !== undefined) query.pageToken = pageToken;
        const [files, next] = await bucket.getFiles(query);

        for (const file of files) {
          const size = z.coerce.number().int().nonnegative().parse(file.metadata.size);

          yield { key: file.name, size };
        }

        pageToken = next?.pageToken;
      } while (pageToken !== undefined);
    },
    remove: async (keys: string[]) => {
      for (const key of keys) await bucket.file(key).delete({ ignoreNotFound: true });
    },
  };
};
