import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { z } from "zod";
import type { CloudflareBindings } from "./lib/server/cloudflare-config.ts";
import { executeCloudflareDeployment } from "./lib/server/cloudflare-deployment.ts";
import { deploymentCommand } from "./lib/server/deployment-execution.ts";

export class DeploymentWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  z.infer<typeof deploymentCommand>
> {
  override async run(
    event: CloudflareWorkersModule.WorkflowEvent<z.infer<typeof deploymentCommand>>,
    step: CloudflareWorkersModule.WorkflowStep,
  ) {
    const command = deploymentCommand.parse(event.payload);

    if (event.instanceId !== command.id)
      throw new Error("Deployment workflow identity does not match its command");

    await executeCloudflareDeployment(this.env, command, step);
  }
}
