import type { z } from "zod";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { readCloudflareConfiguration } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";
import type { deploymentWorkflowCommand } from "./cloudflare-connector-command.ts";
import type { createRuntimeExtension } from "./runtime-extension.ts";
import { observe } from "./observation.ts";

export const observeDeploymentCompletion = async (
  bindings: CloudflareBindings,
  command: z.infer<typeof deploymentWorkflowCommand>,
  outcome: "succeeded" | "failed",
  createExtension: typeof createRuntimeExtension,
) => {
  // Older, already queued commands have no attribution; do not invent attribution.
  if (command.kind !== "deploy" || !command.attribution) return;
  const actor = command.attribution;
  await withCloudflareDatabase(bindings, async ({ db }) => {
    const extension = createExtension({
      database: db,
      configuration: readCloudflareConfiguration(bindings),
    });

    observe(extension.observation, {
      event: "deployment_completed",
      id: `${command.id}:${outcome}`,
      userId: actor.userId,
      organizationId: actor.organizationId,
      properties: {
        app_id: command.appId,
        deployment_id: command.id,
        outcome,
        rollback: command.rollback,
      },
    });
    await extension.observation?.close();
  });
};
