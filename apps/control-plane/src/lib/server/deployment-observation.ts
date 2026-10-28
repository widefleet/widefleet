import { createProductAnalytics } from "./analytics.ts";
import type { AnalyticsEnvironment } from "../analytics-config.ts";
import type { z } from "zod";
import type { deploymentWorkflowCommand } from "./cloudflare-connector-command.ts";
import type { cloudflareAppOperation } from "./cloudflare-app-operation-command.ts";
import { observe } from "./observation.ts";

export const observeWorkflowCompletion = async (
  configuration: AnalyticsEnvironment & { PLATFORM_URL: string },
  workflowId: string,
  command: z.infer<typeof deploymentWorkflowCommand | typeof cloudflareAppOperation> | undefined,
  outcome: "succeeded" | "failed",
  error?: Error,
) => {
  const observation = createProductAnalytics(configuration);

  if (command?.kind === "deploy" && command.attribution) {
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
  }

  if (error) {
    const userId = command?.kind === "deploy" ? command.attribution?.userId : command?.actor.id;

    const organizationId =
      command?.kind === "deploy"
        ? command.attribution?.organizationId
        : command?.actor.application.organizationId;

    observation.exception(error, userId ? `user:${userId}` : undefined, {
      workflow_id: workflowId,
      operation: command?.kind,
      outcome,
      app_id: command && "appId" in command ? command.appId : undefined,
      deployment_id: command?.kind === "deploy" ? command.id : undefined,
      rollback: command?.kind === "deploy" ? command.rollback : undefined,
      $groups: organizationId ? { organization: organizationId } : undefined,
    });
  }

  await observation.close();
};
