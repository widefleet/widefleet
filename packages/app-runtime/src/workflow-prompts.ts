import { workflowEventPrompt } from "@platform/contracts";
import { workflowCatalog } from "./workflow-catalog.ts";
import type { ParentEnvironment } from "./types.ts";
import type { EventWaitOptions, Start } from "./workflow-protocol.ts";

type NativeWaitOptions = Omit<EventWaitOptions, "prompt">;

// Publish an event wait's question in the app's catalog while the native
// engine waits. The engine only receives its own options. The catalog settles
// the wait when it returns or receives its event, so replays of a completed
// wait never offer the question again.
export const waitForPromptedEvent = async <T>(
  environment: ParentEnvironment,
  start: Start,
  step: string,
  name: string,
  { prompt, ...options }: EventWaitOptions,
  wait: (options: NativeWaitOptions) => Promise<T>,
) => {
  if (prompt === undefined) return wait(options);
  const parsed = workflowEventPrompt.parse(prompt);
  const catalog = workflowCatalog(environment, start.appId);
  const scope = { appId: start.appId, hostname: start.hostname, workflow: start.workflow };

  await catalog.publishPrompt(scope, start.id, step, { name, type: options.type, ...parsed });

  try {
    return await wait(options);
  } finally {
    try {
      await catalog.settlePrompt(scope, start.id, step);
    } catch (cause) {
      console.error(cause);
    }
  }
};
