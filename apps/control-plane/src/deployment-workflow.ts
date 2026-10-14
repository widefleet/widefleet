import type {
  CloudflareWorkersModule,
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { CloudflareBindings } from "./lib/server/cloudflare-config.ts";
import {
  dispatchCloudflareDeployment,
  executeCloudflareDeployment,
} from "./lib/server/cloudflare-deployment.ts";

export class DeploymentWorkflow extends WorkflowEntrypoint<CloudflareBindings, { jobId: string }> {
  override async run(
    event: CloudflareWorkersModule.WorkflowEvent<{ jobId: string }>,
    step: CloudflareWorkersModule.WorkflowStep,
  ) {
    const id = z.uuid().parse(event.payload.jobId);

    if (event.instanceId !== id)
      throw new Error("Deployment workflow identity does not match its job");

    await executeCloudflareDeployment(this.env, id, step);
    await step.do("dispatch-next-job", () => dispatchCloudflareDeployment(this.env));
  }
}

export const scheduled = (
  _event: ScheduledController,
  env: CloudflareBindings,
  context: ExecutionContext,
) => {
  context.waitUntil(dispatchCloudflareDeployment(env));
};
