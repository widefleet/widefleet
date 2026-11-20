import { building } from "$app/env";
import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { createRequestRuntime } from "#server/runtime-services";
import { getRuntime } from "#server/runtime-node";
import { checkFormOrigin } from "#server/form-origin";
import { handleSession } from "#server/session";
import { reportRequestException } from "#server/runtime";

export const init: ServerInit = async () => {
  if (!building) await getRuntime();
};

import { proxyAnalyticsRequest } from "#server/analytics-proxy";
import { analyticsEnvironmentSchema, readAnalyticsConfiguration } from "#lib/analytics-config";

export const handle: Handle = async ({ event, resolve }) => {
  const rejected = checkFormOrigin(event.request);

  if (rejected) return rejected;
  event.locals.analytics = readAnalyticsConfiguration(
    analyticsEnvironmentSchema.parse(process.env),
  );
  const analyticsResponse = await proxyAnalyticsRequest(event.request, event.locals.analytics);

  if (analyticsResponse) return analyticsResponse;
  // The control plane is a signed-in management UI; keep all of its pages out of search results.
  event.setHeaders({ "x-robots-tag": "noindex" });
  event.locals.runtime = createRequestRuntime(getRuntime);

  return handleSession({ event, resolve });
};

export const handleError: HandleServerError = async ({ error, kind, event }) => {
  if (kind === "unknown" && error instanceof Error) {
    console.error(error);

    try {
      await reportRequestException(error, event.locals);
    } catch {
      /* Initialization may have failed before reporting is available. */
    }
  }
};
