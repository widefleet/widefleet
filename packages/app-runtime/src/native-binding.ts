import type { NativeBindings, ParentEnvironment } from "./types.ts";

export const nativeBinding = <K extends keyof NativeBindings>(
  environment: ParentEnvironment,
  name: string,
  kind: K,
) => {
  if (!environment[name]) throw new Error(`Missing native ${kind} binding`);

  // SAFETY: Only the trusted loader selects a native name in immutable loopback props.
  return environment[name] as NativeBindings[K];
};
