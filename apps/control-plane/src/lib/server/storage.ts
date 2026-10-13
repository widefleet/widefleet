import { createArtifactStorage } from "./artifact-storage.ts";
import { createAzureStorage } from "./storage/azure.ts";
import type { StorageConfiguration } from "./storage/config.ts";
import { createGcsStorage } from "./storage/gcs.ts";
import { createS3Storage } from "./storage/s3.ts";

export type { ArtifactStorage } from "./artifact-storage.ts";

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
) => createArtifactStorage(store);
