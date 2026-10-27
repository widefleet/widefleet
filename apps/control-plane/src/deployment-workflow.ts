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
  protected observeCompletion?(
    command: z.infer<typeof deploymentWorkflowCommand>,
    outcome: "succeeded" | "failed",
  ): Promise<void>;

  override async run(
    event: CloudflareWorkersModule.WorkflowEvent<z.infer<typeof deploymentWorkflowCommand>>,
    step: CloudflareWorkersModule.WorkflowStep,
  ) {
    const command = deploymentWorkflowCommand.parse(event.payload);

    if (event.instanceId !== command.id)
      throw new Error("Deployment workflow identity does not match its command");

    let outcome: "succeeded" | "failed" = "failed";

    try {
      if (command.kind === "runtime") await executeCloudflareRuntime(this.env, command, step);
      else if (command.kind === "connector")
        await executeCloudflareConnector(this.env, command, step);
      else await executeCloudflareDeployment(this.env, command, step);
      outcome = "succeeded";
    } finally {
      if (command.kind === "deploy" && command.attribution && this.observeCompletion) {
        try {
          await step.do(
            "observe-completion",
            { retries: { limit: 0, delay: "1 second" }, timeout: "5 seconds" },
            async () => {
              await this.observeCompletion?.(command, outcome);
            },
          );
        } catch {
          // Optional observation cannot change a durable operation's outcome.
        }
      }
    }
  }
}
