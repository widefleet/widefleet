import { building } from "$app/env";
import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { createRequestRuntime } from "#server/runtime-services";
import { getRuntime } from "#server/runtime-node";

export const init: ServerInit = async () => {
  if (!building) await getRuntime();
};

import { proxyAnalyticsRequest } from "#server/analytics-proxy";
import { analyticsEnvironmentSchema, readAnalyticsConfiguration } from "#lib/analytics-config";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.analytics = readAnalyticsConfiguration(
    analyticsEnvironmentSchema.parse(process.env),
  );
  const analyticsResponse = await proxyAnalyticsRequest(event.request, event.locals.analytics);

  if (analyticsResponse) return analyticsResponse;
  event.locals.runtime = createRequestRuntime(getRuntime);

  return resolve(event);
};

export const handleError: HandleServerError = async ({ error, kind }) => {
  if (kind === "unknown" && error instanceof Error) {
    console.error(error);

    try {
      (await getRuntime()).reporting.exception(error);
    } catch {
      /* Initialization may have failed before reporting is available. */
    }
  }
};
