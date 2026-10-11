import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { workflowInstanceId, workflowRestartFrom } from "@platform/contracts";
import type {
  WorkflowEvent,
  WorkflowStepConfig,
  WorkflowStepContext,
  WorkflowDelayDuration,
  WorkflowSleepDuration,
  WorkflowTimeoutDuration,
} from "cloudflare:workers";

// Values cross native structured-clone boundaries, which reject capabilities.
export type WorkflowValue = string | number | boolean | bigint | object | null | undefined;

export type Fault = { name: string; message: string; nonRetryable?: boolean };

export const fault = (cause: unknown): Fault =>
  cause instanceof Error
    ? { name: cause.name, message: cause.message, nonRetryable: cause instanceof NonRetryableError }
    : { name: "Error", message: String(cause) };

export const restore = (error: Fault) =>
  error.nonRetryable
    ? new NonRetryableError(error.message, error.name)
    : Object.assign(new Error(error.message), { name: error.name });

export type StepConfig = Omit<WorkflowStepConfig, "retries"> & {
  retries?: {
    limit: number;
    delay: number | WorkflowDelayDuration;
    backoff?: "constant" | "linear" | "exponential";
  };
};

export type StepContext = WorkflowStepContext;

export const stepId = ({ name, type, count }: z.infer<typeof workflowRestartFrom>) =>
  JSON.stringify([name, type, count]);

export const nativeStepName = async (id: string) => {
  // Bounded names avoid truncation and collisions with the bridge's checkpoints.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));

  return `app/${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

export type Command =
  | { kind: "do"; id: string; name: string; count: number; config: StepConfig }
  | { kind: "sleep"; id: string; duration: number | WorkflowSleepDuration }
  | { kind: "sleepUntil"; id: string; deadline: Date | number }
  | {
      kind: "waitForEvent";
      id: string;
      options: { type: string; timeout?: number | WorkflowTimeoutDuration };
    }
  | { kind: "complete"; value: WorkflowValue }
  | { kind: "error"; error: Fault };

export type Reply = { id: string; value?: WorkflowValue; error?: Fault };

export type ReplayCommand = { kind: Command["kind"]; id?: string };

export type Start = {
  appId: string;
  hostname: string;
  version: string;
  workflow: string;
  id: string;
  params?: WorkflowValue;
};

export type AppEvent = WorkflowEvent<WorkflowValue>;

export const workflowOptions = z.strictObject({
  id: workflowInstanceId.optional(),
  params: z.custom<WorkflowValue>().optional(),
  retention: z
    .strictObject({
      successRetention: z
        .custom<WorkflowRetentionDuration>(
          (value) => z.union([z.number().nonnegative(), z.string()]).safeParse(value).success,
        )
        .optional(),
      errorRetention: z
        .custom<WorkflowRetentionDuration>(
          (value) => z.union([z.number().nonnegative(), z.string()]).safeParse(value).success,
        )
        .optional(),
    })
    .optional(),
  locationHint: z
    .enum(["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"])
    .optional(),
});

export type CreateOptions = z.infer<typeof workflowOptions>;
