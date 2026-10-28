import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";

const resources = z.strictObject({
  cpuMs: z.number().int().positive(),
  subRequests: z.number().int().nonnegative(),
});

export const executionLimits = z.strictObject({
  http: resources,
  connector: resources,
  cron: resources,
  workflow: resources,
  readiness: resources,
});

export const executionOptions = (
  environment: Pick<ParentEnvironment, "WIDEFLEET_EXECUTION_LIMITS">,
  profile: keyof z.infer<typeof executionLimits>,
) => {
  const configuration = environment.WIDEFLEET_EXECUTION_LIMITS;

  if (configuration === undefined) return undefined;

  // Select on every invocation: loader caches must not retain an older policy,
  // and HTTP, cron and readiness can share the same cached Worker.
  return { limits: executionLimits.parse(JSON.parse(configuration))[profile] };
};
