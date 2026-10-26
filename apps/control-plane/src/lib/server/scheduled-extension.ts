import type { CloudflareBindings } from "./cloudflare-config.ts";
import { readCloudflareConfiguration } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";
import type { createRuntimeExtension, RuntimeExtension } from "./runtime-extension.ts";

export const runScheduledExtension = (
  bindings: CloudflareBindings,
  event: Parameters<NonNullable<RuntimeExtension["scheduled"]>>[0],
  createExtension: typeof createRuntimeExtension,
) =>
  withCloudflareDatabase(bindings, async ({ db }) => {
    const extension = createExtension({
      database: db,
      configuration: readCloudflareConfiguration(bindings),
    });

    await extension.scheduled?.(event, (name, schema) => schema.parse(bindings[name]));
  });
