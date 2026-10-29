import { NonRetryableError } from "cloudflare:workflows";
import { readExecutionAvailability } from "./availability.ts";
import type { ParentEnvironment } from "./types.ts";

export const requireExecution = async (
  environment: ParentEnvironment,
  identity: Parameters<typeof readExecutionAvailability>[1],
) => {
  if (environment["WIDEFLEET_HTTP_AVAILABILITY"] !== "kv") return;

  try {
    if ((await readExecutionAvailability(environment, identity)).blocked)
      throw new Error("Organization execution is suspended");
  } catch (cause) {
    // Construct the canonical native error in the caller's isolate. RPC does not
    // preserve instanceof, and a normal Error would consume the app's retries.
    throw new NonRetryableError(
      cause instanceof Error ? cause.message : "Organization execution availability is unknown",
    );
  }
};
