import { runtimeExtension } from "#runtime-extension";
import type { WorkflowIdentity, WorkflowObservation } from "./runtime-extension.ts";
import type { ParentEnvironment } from "./types.ts";

export const workflowObserver = (
  context: Pick<ExecutionContext, "waitUntil">,
  environment: ParentEnvironment,
  identity: WorkflowIdentity,
) => {
  const observe = runtimeExtension.workflow;

  if (!observe) return undefined;

  return (event: WorkflowObservation) => {
    context.waitUntil(
      Promise.resolve().then(() =>
        observe(event, identity, (name, schema) => schema.parse(environment[name])),
      ),
    );
  };
};
