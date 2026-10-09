import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { Storage } from "@google-cloud/storage";
import { createStorage } from "../../src/lib/server/storage.ts";
import { createAzureStorage } from "../../src/lib/server/storage/azure.ts";
import { azureStorageSchema, gcsStorageSchema } from "../../src/lib/server/storage/config.ts";
import { createGcsStorage } from "../../src/lib/server/storage/gcs.ts";
import { createStorageFixture } from "./http-fixture.ts";

export const createStorageTestEnvironment = async (provider: "azure" | "gcs") => {
  const fixture = await createStorageFixture(provider);

  if (provider === "azure") {
    const configuration = azureStorageSchema.parse({
      ARTIFACT_STORAGE_PROVIDER: "azure",
      AZURE_STORAGE_ACCOUNT_NAME: "account",
      AZURE_STORAGE_CONTAINER: "artifacts",
      AZURE_STORAGE_ACCESS_KEY: "dGVzdC1rZXk=",
    });

    const client = new BlobServiceClient(
      `${fixture.url}/account`,
      new StorageSharedKeyCredential("account", "dGVzdC1rZXk="),
      { retryOptions: { maxTries: 1 } },
    );

    return {
      ...fixture,
      storage: createStorage(configuration, createAzureStorage(configuration, client)),
    };
  }

  const configuration = gcsStorageSchema.parse({
    ARTIFACT_STORAGE_PROVIDER: "gcs",
    GCS_BUCKET: "artifacts",
  });

  const client = new Storage({
    apiEndpoint: fixture.url,
    useAuthWithCustomEndpoint: false,
    projectId: "widefleet-fixture",
    retryOptions: { autoRetry: false },
  });

  return {
    ...fixture,
    storage: createStorage(configuration, createGcsStorage(configuration, client)),
  };
};
