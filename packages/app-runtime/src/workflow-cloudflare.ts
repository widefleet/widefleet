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
import { workflowObserver } from "./workflow-observation.ts";
import type { WorkflowObservation } from "./runtime-extension.ts";
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
  #observe;
  constructor(step: WorkflowStep, observe?: (event: WorkflowObservation) => void) {
    super();
    this.#step = step;
    this.#observe = observe;
  }
  do(
    name: string,
    config: StepConfig,
    callback: (context: StepContext) => Promise<WorkflowResult>,
  ) {
    return captureWorkflow(() =>
      this.#step.do(name, config, async (context) => {
        // The engine invokes this callback only on execution, not cache replay.
        // Use its persisted attempt number; wrapper calls include cached steps.
        if (context.attempt === 1)
          this.#observe?.({ timestamp: Date.now(), operation: "do", outcome: "started" });
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
      new CloudflareWorkflowSteps(
        step,
        workflowObserver(this.ctx, this.env, {
          appId: start.appId,
          version: start.version,
          workflow: start.workflow,
          instanceId: event.instanceId,
        }),
      ),
    );

    if (result.error)
      throw result.native ? restore(result.error) : nativeWorkflowError(result.error);

    return result.value;
  }
}

export class CloudflareWorkflowCatalog extends WorkflowCatalog {
  protected override async createNative(
    options: WorkflowInstanceCreateOptions<Start> & { id: string; params: Start },
  ) {
    const observe = workflowObserver(this.ctx, this.env, {
      appId: options.params.appId,
      version: options.params.version,
      workflow: options.params.workflow,
      instanceId: options.id,
    });

    if (!observe) return super.createNative(options);
    const timestamp = Date.now();
    let outcome: "ok" | "unknown" = "unknown";

    try {
      const instance = await super.createNative(options);
      outcome = "ok";

      return instance;
    } finally {
      // Before catalog confirmation: its storage can fail after native creation
      // succeeds. Recovery lookups never emit another creation observation.
      observe({ timestamp, operation: "create", outcome });
    }
  }
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
