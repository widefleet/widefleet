import { NonRetryableError } from "cloudflare:workflows";
import {
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowStepRollbackOptions,
} from "cloudflare:workers";
import ApplicationWorkflow from "widefleet:workflow";
import { insideStep } from "./workflow-activity.ts";
import { stepCallback, stepConfig } from "./workflow-step-config.ts";
import {
  restore,
  type AppEvent,
  type StepConfig,
  type StepContext,
  type WorkflowValue,
} from "./workflow-protocol.ts";
import {
  captureWorkflow,
  nativeWorkflowFault,
  NativeWorkflowError,
  type WorkflowResult,
} from "./workflow-cloudflare-errors.ts";
import type { CloudflareWorkflowSteps } from "./workflow-cloudflare.ts";

type Callback = (context: StepContext) => Promise<WorkflowValue>;

const value = async (operation: () => Promise<WorkflowResult>) => {
  if (insideStep.getStore()) throw new NonRetryableError("Workflow steps cannot be nested");
  const result = await operation();

  if (result.error) {
    const error = nativeWorkflowFault(result.error);
    throw error === result.error ? new NativeWorkflowError(error) : restore(error);
  }

  return result.value;
};

const captureApp = <T>(operation: () => Promise<T>) =>
  captureWorkflow(async () => {
    try {
      return await operation();
    } catch (cause) {
      if (!(cause instanceof NativeWorkflowError)) console.error(cause);
      throw cause;
    }
  });

export class WorkflowRunner extends WorkerEntrypoint<Record<string, WorkflowValue>> {
  ready() {
    if (!(ApplicationWorkflow.prototype instanceof WorkflowEntrypoint))
      throw new Error("Workflow classes must extend WorkflowEntrypoint");

    return true;
  }
  run(event: AppEvent, native: Rpc.Stub<CloudflareWorkflowSteps>) {
    return captureApp(async () => {
      this.ready();

      return new ApplicationWorkflow(this.ctx, this.env).run(event, {
        do(
          name: string,
          config: StepConfig | Callback,
          callback?: Callback,
          rollback?: WorkflowStepRollbackOptions<WorkflowValue>,
        ) {
          const functionConfig = stepCallback.safeParse(config);

          if (rollback !== undefined || (functionConfig.success && callback !== undefined))
            throw new Error("Workflow rollback is not supported");
          const invoke = functionConfig.success ? functionConfig.data : callback;

          if (!invoke) throw new Error("A step callback is required");

          return value(() =>
            native.do(name, functionConfig.success ? {} : stepConfig(config), (context) =>
              captureApp(() => insideStep.run(true, () => invoke(context))),
            ),
          );
        },
        sleep: (name, duration) => value(() => native.sleep(name, duration)),
        sleepUntil: (name, deadline) => value(() => native.sleepUntil(name, deadline)),
        waitForEvent: (name, options) => value(() => native.waitForEvent(name, options)),
      });
    });
  }
}
