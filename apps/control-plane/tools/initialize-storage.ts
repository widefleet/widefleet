import { CreateBucketCommand, HeadBucketCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { z } from "zod";
import { readConfiguration } from "../src/lib/server/config.ts";
import { createAzureClient } from "../src/lib/server/storage/azure.ts";
import { createGcsClient } from "../src/lib/server/storage/gcs.ts";
import { createS3Client } from "../src/lib/server/storage/s3.ts";

const configuration = readConfiguration();

const provider = process.env["FLEET_STORAGE_PROVIDER"] ?? "s3";

if (provider !== configuration.ARTIFACT_STORAGE_PROVIDER) {
  throw new Error(
    "This initialization tool requires matching artifact and fleet storage providers",
  );
}

switch (configuration.ARTIFACT_STORAGE_PROVIDER) {
  case "s3": {
    const fleetBucket = z.string().min(3).parse(process.env["FLEET_S3_BUCKET"]);
    const client = createS3Client(configuration);

    try {
      for (const bucket of [configuration.S3_BUCKET, fleetBucket]) {
        try {
          await client.send(new HeadBucketCommand({ Bucket: bucket }));
        } catch (error) {
          if (!(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 404)
            throw error;
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
        }
      }

      console.info("Artifact and fleet buckets initialized");
    } finally {
      client.destroy();
    }

    break;
  }

  case "azure": {
    const fleetContainer = z.string().min(3).parse(process.env["FLEET_AZURE_CONTAINER"]);
    const client = createAzureClient(configuration);

    for (const name of [configuration.AZURE_STORAGE_CONTAINER, fleetContainer]) {
      if (!(await client.getContainerClient(name).exists())) {
        throw new Error(`Azure container ${name} must be provisioned before starting Widefleet`);
      }
    }

    console.info("Existing artifact and fleet containers verified");
    break;
  }

  case "gcs": {
    const fleetBucket = z.string().min(3).parse(process.env["FLEET_GCS_BUCKET"]);
    const client = createGcsClient(configuration);

    for (const name of [configuration.GCS_BUCKET, fleetBucket]) {
      await client.bucket(name).getMetadata();
    }

    console.info("Existing artifact and fleet buckets verified");
    break;
  }
}
