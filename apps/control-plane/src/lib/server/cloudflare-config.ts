import type { Fetcher, Hyperdrive, R2Bucket, Workflow } from "@cloudflare/workers-types";
import { z } from "zod";
import { runtimeConfigurationSchema } from "./config.ts";

export interface CloudflareBindings {
  HYPERDRIVE: Hyperdrive;
  ARTIFACTS: R2Bucket;
  PLATFORM_URL: string;
  APP_DOMAIN: string;
  BETTER_AUTH_SECRET: string;
  PLATFORM_ENCRYPTION_KEY: string;
  DEPLOYMENTS?: Workflow<{ jobId: string }>;
  APP_RUNTIME?: Fetcher;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  APP_RUNTIME_NAME?: string;
  APP_RUNTIME_TOKEN?: string;
  PLATFORM_USAGE_REPORTING?: string;
  PLATFORM_CRASH_REPORTING?: string;
}

export const cloudflareConfigurationSchema = runtimeConfigurationSchema.extend({
  ARTIFACT_STORAGE_PROVIDER: z.literal("r2").default("r2"),
  BETTER_AUTH_SECRET: z.string().min(32),
  PLATFORM_ENCRYPTION_KEY: z.string().min(32),
});

export const readCloudflareConfiguration = (bindings: CloudflareBindings) =>
  cloudflareConfigurationSchema.parse({
    ...bindings,
    DATABASE_URL: bindings.HYPERDRIVE.connectionString,
  });
