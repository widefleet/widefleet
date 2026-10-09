import { version } from "$app/env";
import type { RequestEvent } from "@sveltejs/kit";
import { describeError } from "../errors.ts";

/** Report a handled technical failure without exposing its details in the response. */
export const captureError = (cause: unknown, event: RequestEvent) => {
  try {
    console.error(
      JSON.stringify({
        widefleet: 1,
        kind: "error",
        source: "server",
        buildId: version,
        deploymentId: event.platform?.env.WIDEFLEET_DEPLOYMENT_ID ?? null,
        requestId: event.locals.requestId,
        route: event.route.id ?? event.url.pathname,
        ...describeError(cause),
      }),
    );
    event.locals.errorReported = true;
  } catch {
    // A reporting failure must not replace the original application error.
  }
};
