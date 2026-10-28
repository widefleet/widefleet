import { createProductAnalytics } from "./analytics.ts";
import type { AnalyticsEnvironment } from "../analytics-config.ts";
import type { z } from "zod";
import type { deploymentWorkflowCommand } from "./cloudflare-connector-command.ts";
import { observe } from "./observation.ts";

export const observeDeploymentCompletion = async (
  configuration: AnalyticsEnvironment & { PLATFORM_URL: string },
  command: z.infer<typeof deploymentWorkflowCommand>,
  outcome: "succeeded" | "failed",
  error?: Error,
) => {
  const observation = createProductAnalytics(configuration);

  if (command.kind === "deploy" && command.attribution) {
    const actor = command.attribution;

    const properties = {
      app_id: command.appId,
      deployment_id: command.id,
      outcome,
      rollback: command.rollback,
    };

    observe(observation, {
      event: "deployment_completed",
      id: `${command.id}:${outcome}`,
      userId: actor.userId,
      organizationId: actor.organizationId,
      properties,
    });

    if (error)
      observation.exception(error, `user:${actor.userId}`, {
        ...properties,
        $groups: { organization: actor.organizationId },
      });
  } else if (error) {
    observation.exception(error, undefined, { workflow_id: command.id, operation: command.kind });
  }

  await observation.close();
};
