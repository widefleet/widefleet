import { env, waitUntil } from "cloudflare:workers";
import type { Handle, HandleServerError } from "@sveltejs/kit/hooks";
import { createCloudflareRuntime } from "#server/runtime-cloudflare";

import { proxyAnalyticsRequest } from "#server/analytics-proxy";
import { analyticsEnvironmentSchema, readAnalyticsConfiguration } from "#lib/analytics-config";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.analytics = readAnalyticsConfiguration(analyticsEnvironmentSchema.parse(env));
  const analyticsResponse = await proxyAnalyticsRequest(event.request, event.locals.analytics);

  if (analyticsResponse) return analyticsResponse;
  const runtime = createCloudflareRuntime(env);
  event.locals.runtime = runtime.get;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    waitUntil(runtime.close());
  };

  try {
    const response = await resolve(event);

    if (!response.body) {
      close();

      return response;
    }

    // Deferred page data can still use PostgreSQL after the response headers are sent.
    const reader = response.body.getReader();

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(error);
          close();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          close();
        }
      },
    });

    return new Response(body, response);
  } catch (error) {
    close();
    throw error;
  }
};

export const handleError: HandleServerError = async ({ error, kind, event }) => {
  if (kind === "unknown" && error instanceof Error) {
    console.error(error);

    try {
      (await event.locals.runtime()).reporting.exception(error);
    } catch {
      /* Initialization may have failed. */
    }
  }
};
