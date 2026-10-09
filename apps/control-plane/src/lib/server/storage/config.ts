import { isAbsolute } from "node:path";
import { z } from "zod";

const credentialFile = z.string().min(1).refine(isAbsolute, "Use an absolute credential file path");

export const s3StorageSchema = z.object({
  ARTIFACT_STORAGE_PROVIDER: z.literal("s3"),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

export const azureStorageSchema = z
  .object({
    ARTIFACT_STORAGE_PROVIDER: z.literal("azure"),
    AZURE_STORAGE_ACCOUNT_NAME: z.string().regex(/^[a-z0-9]{3,24}$/),
    AZURE_STORAGE_CONTAINER: z.string().regex(/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/),
    AZURE_STORAGE_ACCESS_KEY: z.string().min(1).optional(),
    AZURE_CLIENT_ID: z.uuid().optional(),
    AZURE_TENANT_ID: z.uuid().optional(),
    AZURE_FEDERATED_TOKEN_FILE: credentialFile.optional(),
  })
  .superRefine((value, context) => {
    const workload =
      value.AZURE_TENANT_ID !== undefined || value.AZURE_FEDERATED_TOKEN_FILE !== undefined;

    if (
      value.AZURE_STORAGE_ACCESS_KEY !== undefined &&
      (value.AZURE_CLIENT_ID !== undefined || workload)
    ) {
      context.addIssue({
        code: "custom",
        message: "Choose an Azure account key or an identity, not both",
      });
    }

    if (
      workload &&
      (value.AZURE_CLIENT_ID === undefined ||
        value.AZURE_TENANT_ID === undefined ||
        value.AZURE_FEDERATED_TOKEN_FILE === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Azure workload identity requires AZURE_CLIENT_ID, AZURE_TENANT_ID and AZURE_FEDERATED_TOKEN_FILE",
      });
    }
  });

export const gcsStorageSchema = z.object({
  ARTIFACT_STORAGE_PROVIDER: z.literal("gcs"),
  GCS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/),
  GOOGLE_APPLICATION_CREDENTIALS: credentialFile.optional(),
});

export const artifactStorageSchema = z
  .object({
    ARTIFACT_STORAGE_PROVIDER: z.enum(["s3", "azure", "gcs"]).default("s3"),
  })
  .passthrough()
  .pipe(
    z.discriminatedUnion("ARTIFACT_STORAGE_PROVIDER", [
      s3StorageSchema,
      azureStorageSchema,
      gcsStorageSchema,
    ]),
  );

export type StorageConfiguration = z.infer<typeof artifactStorageSchema>;
