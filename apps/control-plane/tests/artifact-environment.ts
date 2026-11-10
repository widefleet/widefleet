import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../src/lib/server/storage/s3.ts";
import { createTestEnvironment as createBaseEnvironment } from "./environment.ts";

export const createTestEnvironment = async (...input: Parameters<typeof createBaseEnvironment>) => {
  const environment = await createBaseEnvironment(...input);

  if (environment.configuration.ARTIFACT_STORAGE_PROVIDER !== "s3")
    throw new Error("Expected the S3 test fixture");
  const Bucket = `test-${crypto.randomUUID()}`;
  environment.environment.S3_BUCKET = Bucket;
  environment.configuration.S3_BUCKET = Bucket;
  const client = createS3Client(environment.configuration);

  try {
    await client.send(new CreateBucketCommand({ Bucket }));
  } catch (cause) {
    client.destroy();
    await environment.close();
    throw cause;
  }

  return {
    ...environment,
    close: async () => {
      try {
        // Connector apps upload artifacts during organization setup.
        // Each test installation owns a bucket and removes its contents on exit.
        for (;;) {
          const page = await client.send(new ListObjectsV2Command({ Bucket }));
          const Objects = (page.Contents ?? []).flatMap(({ Key }) => (Key ? [{ Key }] : []));

          if (!Objects.length) break;

          const deleted = await client.send(
            new DeleteObjectsCommand({ Bucket, Delete: { Objects } }),
          );

          if (deleted.Errors?.length) throw new Error("Could not remove test artifacts");
        }

        await client.send(new DeleteBucketCommand({ Bucket }));
      } finally {
        client.destroy();
        await environment.close();
      }
    },
  };
};
