import { z } from "zod";

export const reportingPreferences = z.strictObject({ usage: z.boolean(), crashes: z.boolean() });

export const reportingFrame = z.strictObject({
  function: z
    .string()
    .max(120)
    .regex(/^[a-zA-Z_$][a-zA-Z0-9_.$<>]*$/)
    .optional(),
  filename: z
    .string()
    .max(240)
    .regex(
      /^(?:(?:apps\/control-plane|packages\/contracts|crates\/platform-(?:core|cli|agent))\/src\/[a-zA-Z0-9_./+[\]-]+\.(?:ts|js|svelte|rs)|_app\/immutable\/[a-zA-Z0-9_./+[\]-]+\.js|build\/server\/[a-zA-Z0-9_./+[\]-]+\.js)$/,
    )
    .refine((value) => !value.includes("..")),
  lineno: z.number().int().min(1).max(10_000_000),
  colno: z.number().int().min(1).max(10_000_000).optional(),
});

export const reportingError = z.strictObject({
  type: z.enum([
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "URIError",
    "AggregateError",
    "Panic",
    "Http",
    "Io",
    "Json",
    "Invalid",
    "Credentials",
    "Api",
  ]),
  frames: z.array(reportingFrame).max(20),
});

export const reportingVersion = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);

export const agentReporting = z.strictObject({
  version: reportingVersion,
  os: z.enum(["linux", "macos", "windows", "other"]),
  arch: z.enum(["x86_64", "aarch64", "other"]),
  error: reportingError.optional(),
});

export const browserReporting = z.strictObject({
  version: reportingVersion,
  error: reportingError,
});

export const reportingOperation = z.strictObject({
  operation: z.enum([
    "deploy",
    "rollback",
    "runtime_update",
    "runtime_rollback",
    "connector",
    "delete",
    "configure",
    "migrations",
    "workflows",
  ]),
  outcome: z.enum(["succeeded", "failed"]),
  elapsed_ms: z.number().min(0),
  attempt: z.number().int().min(1),
});

export const reportingStatus = z.strictObject({
  installationId: z.uuid(),
  preferences: reportingPreferences,
  effective: reportingPreferences,
  managed: reportingPreferences,
});

// Only source locations from Widefleet's own files survive. Messages, URLs,
// absolute prefixes, source text and arbitrary properties never leave the process.
export const sanitizeReportingError = (error: Error) => {
  const type = reportingError.shape.type.safeParse(error.name);
  const frames: z.infer<typeof reportingFrame>[] = [];

  const header = error.toString();

  const stack = error.stack?.startsWith(header)
    ? error.stack.slice(header.length)
    : (error.stack ?? "");

  for (const line of stack.split("\n").slice(0, 50)) {
    const location =
      /((?:(?:apps\/control-plane|packages\/contracts|crates\/platform-(?:core|cli|agent))\/src\/|_app\/immutable\/|build\/server\/)[a-zA-Z0-9_./+[\]-]+):(\d+):(\d+)\)?$/.exec(
        line,
      );

    if (!location) continue;

    const frame = reportingFrame.safeParse({
      function: /^\s*at (?:async )?([a-zA-Z_$][a-zA-Z0-9_.$<>]*) \(/.exec(line)?.[1],
      filename: location[1],
      lineno: Number(location[2]),
      colno: Number(location[3]),
    });

    if (frame.success) frames.push(frame.data);

    if (frames.length === 20) break;
  }

  return { type: type.success ? type.data : ("Error" as const), frames };
};
