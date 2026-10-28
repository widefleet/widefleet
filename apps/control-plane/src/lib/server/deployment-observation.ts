import { createProductAnalytics } from "./analytics.ts";
import type { AnalyticsEnvironment } from "../analytics-config.ts";
import type { z } from "zod";
import type { deploymentWorkflowCommand } from "./cloudflare-connector-command.ts";
import { observe, closeObservation } from "./observation.ts";

export const observeDeploymentCompletion = async (
  configuration: AnalyticsEnvironment & { PLATFORM_URL: string },
  command: z.infer<typeof deploymentWorkflowCommand>,
  outcome: "succeeded" | "failed",
) => {
  // Older, already queued commands have no attribution; do not invent attribution.
  if (command.kind !== "deploy" || !command.attribution) return;

  const actor = command.attribution;
  const observation = createProductAnalytics(configuration);

  observe(observation, {
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
  await closeObservation(observation);
};
