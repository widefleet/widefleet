import { runtimeConfigurationSchema } from "./lib/server/config.ts";
import { analyticsEnvironmentSchema, readAnalyticsConfiguration } from "./lib/analytics-config.ts";
import { observeDeploymentCompletion } from "./lib/server/deployment-observation.ts";
import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { z } from "zod";
import type { CloudflareBindings } from "./lib/server/cloudflare-config.ts";
import { executeCloudflareDeployment } from "./lib/server/cloudflare-deployment.ts";
import { deploymentWorkflowCommand } from "./lib/server/cloudflare-connector-command.ts";
import { executeCloudflareConnector } from "./lib/server/cloudflare-connector-deployment.ts";
import { executeCloudflareRuntime } from "./lib/server/cloudflare-runtime-deployment.ts";

export class DeploymentWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  z.infer<typeof deploymentWorkflowCommand>
> {
  override async run(
    event: CloudflareWorkersModule.WorkflowEvent<z.infer<typeof deploymentWorkflowCommand>>,
    step: CloudflareWorkersModule.WorkflowStep,
  ) {
    const command = deploymentWorkflowCommand.parse(event.payload);

    if (event.instanceId !== command.id)
      throw new Error("Deployment workflow identity does not match its command");

    let outcome: "succeeded" | "failed" = "failed";
    let failure: Error | undefined;

    try {
      if (command.kind === "runtime") await executeCloudflareRuntime(this.env, command, step);
      else if (command.kind === "connector")
        await executeCloudflareConnector(this.env, command, step);
      else await executeCloudflareDeployment(this.env, command, step);
      outcome = "succeeded";
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      if ((command.kind === "deploy" && command.attribution) || failure) {
        try {
          const configuration = {
            ...analyticsEnvironmentSchema.parse(this.env),
            PLATFORM_URL: runtimeConfigurationSchema.shape.PLATFORM_URL.parse(
              this.env.PLATFORM_URL,
            ),
          };

          const analytics = readAnalyticsConfiguration(configuration);

          if (analytics && analytics.origin === configuration.PLATFORM_URL)
            await step.do(
              "observe-completion",
              { retries: { limit: 0, delay: "1 second" }, timeout: "5 seconds" },
              () => observeDeploymentCompletion(configuration, command, outcome, failure),
            );
        } catch {
          // Optional observation cannot change a durable operation's outcome.
        }
      }
    }
  }
}
