import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { StorageConfiguration } from "./config.ts";

export const createS3Client = (
  configuration: Extract<StorageConfiguration, { ARTIFACT_STORAGE_PROVIDER: "s3" }>,
) =>
  new S3Client({
    endpoint: configuration.S3_ENDPOINT,
    region: configuration.S3_REGION,
    forcePathStyle: true,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30_000 },
    credentials: {
      accessKeyId: configuration.S3_ACCESS_KEY_ID,
      secretAccessKey: configuration.S3_SECRET_ACCESS_KEY,
    },
  });

export const createS3Storage = (
  configuration: Extract<StorageConfiguration, { ARTIFACT_STORAGE_PROVIDER: "s3" }>,
  client = createS3Client(configuration),
) => {
  const bucket = configuration.S3_BUCKET;

  return {
    put: async (key: string, bytes: Uint8Array, contentType: string) => {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            IfNoneMatch: "*",
          }),
        );
      } catch (cause) {
        if (cause instanceof S3ServiceException && cause.$metadata.httpStatusCode === 412) return;
        throw cause;
      }
    },
    get: async (key: string) => {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

      if (result.Body === undefined)
        throw new Error("Object storage returned an empty response body");

      return result.Body.transformToByteArray();
    },
    exists: async (key: string) => {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

        return true;
      } catch (cause) {
        if (cause instanceof S3ServiceException && cause.$metadata.httpStatusCode === 404)
          return false;
        throw cause;
      }
    },
    async *list(prefix: string) {
      let continuationToken: string | undefined;

      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );

        for (const entry of page.Contents ?? []) {
          if (entry.Key !== undefined && entry.Size !== undefined)
            yield { key: entry.Key, size: entry.Size };
        }

        continuationToken = page.NextContinuationToken;
      } while (continuationToken !== undefined);
    },
    remove: async (keys: string[]) => {
      const deleted = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );

      if ((deleted.Errors?.length ?? 0) > 0)
        throw new Error("Object storage did not delete all app artifacts");
    },
  };
};
