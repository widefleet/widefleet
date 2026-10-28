import { NonRetryableError } from "cloudflare:workflows";
import { requireOrganizationAvailability } from "./availability.ts";
import { workflowCatalog } from "./workflow-catalog.ts";
import type { ParentEnvironment } from "./types.ts";

// The parent supplies this scope in immutable loopback props, never app input.
export type ExecutionScope = { appId: string; hostname: string } | { organizationId: string };

export const requireExecution = async (environment: ParentEnvironment, scope: ExecutionScope) => {
  if (environment["WIDEFLEET_HTTP_AVAILABILITY"] !== "kv") return;

  try {
    if ("appId" in scope) await workflowCatalog(environment, scope.appId).requireExecution(scope);
    else await requireOrganizationAvailability(environment, scope.organizationId);
  } catch (cause) {
    // Construct the canonical native error in the caller's isolate. RPC does not
    // preserve instanceof, and a normal Error would consume the app's retries.
    throw new NonRetryableError(
      cause instanceof Error ? cause.message : "Organization execution availability is unknown",
    );
  }
};
