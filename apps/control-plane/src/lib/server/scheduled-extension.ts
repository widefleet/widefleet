import { createProductAnalytics } from "./analytics.ts";
import { analyticsEnvironmentSchema } from "../analytics-config.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { readCloudflareConfiguration } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";
import type { createRuntimeExtension, RuntimeExtension } from "./runtime-extension.ts";

export const runScheduledExtension = async (
  bindings: CloudflareBindings,
  event: Parameters<NonNullable<RuntimeExtension["scheduled"]>>[0],
  createExtension: typeof createRuntimeExtension,
) => {
  try {
    await withCloudflareDatabase(bindings, async ({ db }) => {
      const extension = createExtension({
        database: db,
        binding: (name, schema) => schema.parse(bindings[name]),
        configuration: readCloudflareConfiguration(bindings),
      });

      await extension.scheduled?.(event, (name, schema) => schema.parse(bindings[name]));
    });
  } catch (error) {
    try {
      const observation = createProductAnalytics({
        ...analyticsEnvironmentSchema.parse(bindings),
        PLATFORM_URL: new URL(bindings.PLATFORM_URL).origin,
      });

      observation.exception(error instanceof Error ? error : new Error(String(error)), undefined, {
        operation: "scheduled",
        cron: event.cron,
      });
      await observation.close();
    } catch {
      // Reporting must preserve the original scheduled invocation failure.
    }

    throw error;
  }
};
