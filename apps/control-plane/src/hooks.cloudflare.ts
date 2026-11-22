import { env, waitUntil } from "cloudflare:workers";
import { isHttpError, isRedirect } from "@sveltejs/kit";
import type { Handle, HandleServerError } from "@sveltejs/kit/hooks";
import { createCloudflareRuntime } from "#server/runtime-cloudflare";
import { createProductAnalytics } from "#server/analytics";
import { checkFormOrigin } from "#server/form-origin";
import { handleSession } from "#server/session";
import { reportRequestException } from "#server/runtime";

import { proxyAnalyticsRequest } from "#server/analytics-proxy";
import { analyticsEnvironmentSchema, readAnalyticsConfiguration } from "#lib/analytics-config";

// SvelteKit reports an unexpected error from this hook after the hook has returned. The request's
// services stay open until handleError has reported it with them, then close.
const failedRequests = new WeakMap<Request, ReturnType<typeof createCloudflareRuntime>>();

export const handle: Handle = async ({ event, resolve }) => {
  const rejected = checkFormOrigin(event.request);

  if (rejected) return rejected;
  event.locals.analytics = readAnalyticsConfiguration(analyticsEnvironmentSchema.parse(env));
  const analyticsResponse = await proxyAnalyticsRequest(event.request, event.locals.analytics);

  if (analyticsResponse) return analyticsResponse;
  // The control plane is a signed-in management UI; keep all of its pages out of search results.
  event.setHeaders({ "x-robots-tag": "noindex" });
  const runtime = createCloudflareRuntime(env);
  event.locals.runtime = runtime.get;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    waitUntil(runtime.close());
  };

  try {
    // Deferred rendering continues from this call, so it keeps the request's services.
    const response = await runtime.run(() => handleSession({ event, resolve }));

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
    // Redirects and HTTP errors are responses, which SvelteKit does not pass to handleError.
    if (isHttpError(error) || isRedirect(error)) close();
    else failedRequests.set(event.request, runtime);
    throw error;
  }
};

const reportError = async (
  error: Error,
  locals: App.Locals,
  failed: ReturnType<typeof createCloudflareRuntime> | undefined,
) => {
  console.error(error);

  try {
    await (failed
      ? failed.run(() => reportRequestException(error, locals))
      : reportRequestException(error, locals));
  } catch {
    try {
      const observation = createProductAnalytics({
        ...analyticsEnvironmentSchema.parse(env),
        PLATFORM_URL: new URL(env.PLATFORM_URL).origin,
      });

      observation.exception(error);
      waitUntil(observation.close());
    } catch {
      // Invalid analytics configuration must not replace the initialization error.
    }
  }
};

export const handleError: HandleServerError = async ({ error, kind, event }) => {
  const failed = failedRequests.get(event.request);

  failedRequests.delete(event.request);

  try {
    if (kind === "unknown" && error instanceof Error)
      await reportError(error, event.locals, failed);
  } finally {
    if (failed) waitUntil(failed.close());
  }
};
