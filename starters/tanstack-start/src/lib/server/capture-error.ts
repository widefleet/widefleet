import { env } from "cloudflare:workers";
import { getGlobalStartContext } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { z } from "zod";
import { describeError } from "../errors.ts";
import type { PlatformContext } from "./context.ts";

/** Report a technical failure without exposing its details in the response. */
export const captureError = (cause: unknown, context?: PlatformContext, request?: Request) => {
  try {
    if (isRedirect(cause) || isNotFound(cause) || cause instanceof z.ZodError) return;
    const status = z.object({ status: z.number() }).safeParse(cause);

    if (status.success && status.data.status < 500) return;
    const current = context ?? getGlobalStartContext();

    if (!current || current.reportedErrors.has(cause)) return;
    current.reportedErrors.add(cause);
    console.error(
      JSON.stringify({
        widefleet: 1,
        kind: "error",
        source: "server",
        buildId: __WIDEFLEET_BUILD_ID__,
        deploymentId: env.WIDEFLEET_DEPLOYMENT_ID ?? null,
        requestId: current.requestId,
        route: new URL((request ?? getRequest()).url).pathname,
        ...describeError(cause),
      }),
    );
  } catch {
    // A reporting failure must not replace the original application error.
  }
};
