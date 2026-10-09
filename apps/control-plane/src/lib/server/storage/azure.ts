import { ManagedIdentityCredential, WorkloadIdentityCredential } from "@azure/identity";
import { BlobServiceClient, StorageSharedKeyCredential, isRestError } from "@azure/storage-blob";
import type { StorageConfiguration } from "./config.ts";

type AzureConfiguration = Extract<StorageConfiguration, { ARTIFACT_STORAGE_PROVIDER: "azure" }>;

const credential = (configuration: AzureConfiguration) => {
  if (configuration.AZURE_STORAGE_ACCESS_KEY !== undefined) {
    return new StorageSharedKeyCredential(
      configuration.AZURE_STORAGE_ACCOUNT_NAME,
      configuration.AZURE_STORAGE_ACCESS_KEY,
    );
  }

  if (
    configuration.AZURE_FEDERATED_TOKEN_FILE !== undefined &&
    configuration.AZURE_CLIENT_ID !== undefined &&
    configuration.AZURE_TENANT_ID !== undefined
  ) {
    return new WorkloadIdentityCredential({
      clientId: configuration.AZURE_CLIENT_ID,
      tenantId: configuration.AZURE_TENANT_ID,
      tokenFilePath: configuration.AZURE_FEDERATED_TOKEN_FILE,
    });
  }

  return configuration.AZURE_CLIENT_ID === undefined
    ? new ManagedIdentityCredential()
    : new ManagedIdentityCredential({ clientId: configuration.AZURE_CLIENT_ID });
};

export const createAzureClient = (configuration: AzureConfiguration) =>
  new BlobServiceClient(
    `https://${configuration.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
    credential(configuration),
    { retryOptions: { maxTries: 3, tryTimeoutInMs: 30_000 } },
  );

export const createAzureStorage = (
  configuration: AzureConfiguration,
  client = createAzureClient(configuration),
) => {
  const container = client.getContainerClient(configuration.AZURE_STORAGE_CONTAINER);

  return {
    put: async (key: string, bytes: Uint8Array, contentType: string) => {
      try {
        await container.getBlockBlobClient(key).uploadData(bytes, {
          conditions: { ifNoneMatch: "*" },
          blobHTTPHeaders: { blobContentType: contentType },
          abortSignal: AbortSignal.timeout(30_000),
        });
      } catch (cause) {
        // Only an existing blob satisfies this create-only write; lease and policy errors do not.
        if (
          isRestError(cause) &&
          ((cause.statusCode === 409 && cause.code === "BlobAlreadyExists") ||
            (cause.statusCode === 412 && cause.code === "ConditionNotMet"))
        )
          return;
        throw cause;
      }
    },
    get: async (key: string) =>
      new Uint8Array(
        await container
          .getBlobClient(key)
          .downloadToBuffer(0, undefined, { abortSignal: AbortSignal.timeout(30_000) }),
      ),
    exists: (key: string) =>
      container.getBlobClient(key).exists({ abortSignal: AbortSignal.timeout(30_000) }),
    async *list(prefix: string) {
      for await (const entry of container.listBlobsFlat({ prefix })) {
        const size = entry.properties.contentLength;

        if (size === undefined) throw new Error("Blob listing omitted its content length");
        yield { key: entry.name, size };
      }
    },
    remove: async (keys: string[]) => {
      for (const key of keys) {
        await container
          .getBlobClient(key)
          .deleteIfExists({ abortSignal: AbortSignal.timeout(30_000) });
      }
    },
  };
};
