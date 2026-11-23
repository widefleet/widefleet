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
  const response = await handleSession({ event, resolve });

  // Pages show private data. Without no-store, the browser's Back button can show a page again
  // after sign-out. SvelteKit already sends no-store for page data and remote function responses.
  if (response.headers.get("content-type")?.startsWith("text/html"))
    response.headers.set("cache-control", "private, no-store");

  return response;
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
