import type { Hyperdrive, R2Bucket } from "@cloudflare/workers-types";
import { z } from "zod";
import { runtimeConfigurationSchema } from "./config.ts";

export interface CloudflareBindings {
  HYPERDRIVE: Hyperdrive;
  ARTIFACTS: R2Bucket;
  PLATFORM_URL: string;
  APP_DOMAIN: string;
  BETTER_AUTH_SECRET: string;
  PLATFORM_ENCRYPTION_KEY: string;
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
