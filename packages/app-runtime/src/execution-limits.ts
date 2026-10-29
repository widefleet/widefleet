import { z } from "zod";

const resources = z.strictObject({
  cpuMs: z.number().int().positive(),
  subRequests: z.number().int().nonnegative(),
});

export const executionLimits = z.strictObject({
  http: resources,
  service: resources,
  cron: resources,
  workflow: resources,
  readiness: resources,
});

export const executionOptions = (
  configuration: string | undefined,
  profile: keyof z.infer<typeof executionLimits>,
) => {
  if (configuration === undefined) return undefined;

  // Select on every invocation: loader caches must not retain an older policy,
  // and HTTP, cron and readiness can share the same cached Worker.
  return { limits: executionLimits.parse(JSON.parse(configuration))[profile] };
};
