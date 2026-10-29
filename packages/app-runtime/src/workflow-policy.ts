import { z } from "zod";
import type { StepConfig } from "./workflow-protocol.ts";

const policy = z.strictObject({
  maxRetries: z.number().int().min(0).max(10_000),
  minRetryDelayMs: z.number().int().positive(),
  maxTimeoutMs: z.number().int().positive(),
});

const units = new Map([
  ["millisecond", 1],
  ["second", 1000],
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
  ["month", 2_592_000_000],
  ["year", 31_536_000_000],
]);

const milliseconds = (value: number | string) => {
  if (z.number().safeParse(value).success) return z.number().nonnegative().parse(value);

  const match =
    /^(\d+(?:\.\d+)?) (milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)$/.exec(
      z.string().parse(value),
    );

  const unit = match?.[2]?.replace(/s$/, "");
  const multiplier = unit ? units.get(unit) : undefined;

  if (!match?.[1] || multiplier === undefined) throw new Error("Unsupported Workflow duration");

  return z
    .number()
    .nonnegative()
    .parse(Number(match[1]) * multiplier);
};

// Apply installation limits in the trusted parent, including to pinned apps.
// Installations without a policy retain the native engine's configuration.
export const workflowStepPolicy = (configuration: StepConfig, value: string | undefined) => {
  if (!value) return configuration;
  const limits = policy.parse(JSON.parse(value));

  return {
    ...configuration,
    timeout: Math.min(milliseconds(configuration.timeout ?? 600_000), limits.maxTimeoutMs),
    retries: {
      limit: Math.min(configuration.retries?.limit ?? 5, limits.maxRetries),
      delay: Math.max(milliseconds(configuration.retries?.delay ?? 10_000), limits.minRetryDelayMs),
      backoff: configuration.retries?.backoff ?? "exponential",
    },
  };
};
