import {
  RpcTarget,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { workflowRestartFrom } from "@platform/contracts";
import type { z } from "zod";
import { workflowApp } from "./workflow-app.ts";
import { workerCode } from "./worker.ts";
import { WorkflowCatalog } from "./workflow-catalog.ts";
import type { ParentEnvironment } from "./types.ts";
import { restore, type Start, type StepConfig, type StepContext } from "./workflow-protocol.ts";
import type { WorkflowRunner } from "./workflow-cloudflare-runner.ts";
import {
  captureWorkflow,
  nativeWorkflowError,
  nativeWorkflowFault,
  type WorkflowResult,
} from "./workflow-cloudflare-errors.ts";

// Forward directly to the native engine. Only error transport is adapted;
// the engine owns step identities, checkpoints, retries and resumption.
export class CloudflareWorkflowSteps extends RpcTarget {
  #step;
  constructor(step: WorkflowStep) {
    super();
    this.#step = step;
  }
  do(
    name: string,
    config: StepConfig,
    callback: (context: StepContext) => Promise<WorkflowResult>,
  ) {
    return captureWorkflow(() =>
      this.#step.do(name, config, async (context) => {
        const result = await callback(context);

        if (result.error)
          throw result.native ? restore(result.error) : nativeWorkflowError(result.error);

        return result.value;
      }),
    );
  }
  sleep(...args: Parameters<WorkflowStep["sleep"]>) {
    return captureWorkflow(async () => {
      await this.#step.sleep(...args);

      return undefined;
    });
  }
  sleepUntil(...args: Parameters<WorkflowStep["sleepUntil"]>) {
    return captureWorkflow(async () => {
      await this.#step.sleepUntil(...args);

      return undefined;
    });
  }
  waitForEvent(...args: Parameters<WorkflowStep["waitForEvent"]>) {
    return captureWorkflow(() => this.#step.waitForEvent(...args));
  }
}

export class CloudflareAppWorkflow extends WorkflowEntrypoint<ParentEnvironment, Start> {
  override async run(event: WorkflowEvent<Start>, step: WorkflowStep) {
    const start = event.payload;
    const app = await workflowApp(start, this.env);

    const worker = this.env.WIDEFLEET_LOADER.load(
      await workerCode(
        app,
        this.env,
        this.ctx,
        start.workflow,
        WIDEFLEET_CLOUDFLARE_WORKFLOW_SOURCE,
      ),
    );

    const result = await worker.getEntrypoint<WorkflowRunner>("WorkflowRunner").run(
      {
        payload: start.params,
        timestamp: event.timestamp,
        instanceId: start.id,
        workflowName: start.workflow,
      },
      new CloudflareWorkflowSteps(step),
    );

    if (result.error)
      throw result.native ? restore(result.error) : nativeWorkflowError(result.error);

    return result.value;
  }
}

export class CloudflareWorkflowCatalog extends WorkflowCatalog {
  protected override async restartTarget(from: z.infer<typeof workflowRestartFrom>) {
    return from;
  }
  protected override async status(instance: WorkflowInstance) {
    const result = await instance.status();

    if (!result.error) return result;
    const error = nativeWorkflowFault(result.error);

    return { ...result, error: { name: error.name, message: error.message } };
  }
}
