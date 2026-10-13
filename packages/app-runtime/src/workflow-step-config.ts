import { z } from "zod";
import type { WorkflowDelayDuration, WorkflowTimeoutDuration } from "cloudflare:workers";
import type { StepConfig, StepContext, WorkflowValue } from "./workflow-protocol.ts";

export const stepCallback = z.function({
  input: [z.custom<StepContext>()],
  output: z.promise(z.custom<WorkflowValue>()),
});

const configuration = z.strictObject({
  retries: z
    .strictObject({
      limit: z.number().int().min(0).max(10000),
      delay: z.union([
        z.number().nonnegative(),
        z.custom<WorkflowDelayDuration>((value) => z.string().safeParse(value).success),
      ]),
      backoff: z.enum(["constant", "linear", "exponential"]).optional(),
    })
    .optional(),
  timeout: z
    .union([
      z.number().nonnegative(),
      z.custom<WorkflowTimeoutDuration>((value) => z.string().safeParse(value).success),
    ])
    .optional(),
  sensitive: z.literal("output").optional(),
});

export const stepConfig = (
  input: StepConfig | ((context: StepContext) => Promise<WorkflowValue>),
) => {
  const parsed = configuration.parse(input);
  const options: StepConfig = {};

  if (parsed.timeout !== undefined) options.timeout = parsed.timeout;

  if (parsed.sensitive !== undefined) options.sensitive = parsed.sensitive;

  if (parsed.retries) {
    options.retries = { limit: parsed.retries.limit, delay: parsed.retries.delay };

    if (parsed.retries.backoff) options.retries.backoff = parsed.retries.backoff;
  }

  return options;
};
