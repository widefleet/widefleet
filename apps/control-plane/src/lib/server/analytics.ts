import { PostHog } from "posthog-node";
import type { Observation, ObservationEvent } from "./observation.ts";
import type { AnalyticsEnvironment } from "../analytics-config.ts";
import { readAnalyticsConfiguration } from "../analytics-config.ts";

export const createProductAnalytics = (
  configuration: AnalyticsEnvironment & { PLATFORM_URL: string },
  transport: typeof fetch = fetch,
) => {
  const config = readAnalyticsConfiguration(configuration);

  const sdk =
    config && configuration.PLATFORM_URL === config.origin
      ? new PostHog(config.projectToken, {
          host: config.ingestOrigin,
          flushAt: 1,
          flushInterval: 0,
          requestTimeout: 1500,
          fetchRetryCount: 0,
          fetch: (url, options) => transport(url, { ...options, redirect: "manual" }),
        })
      : undefined;

  return {
    capture: (event: ObservationEvent) => {
      if (!event.userId && !event.organizationId) return;
      sdk?.capture({
        distinctId: event.userId ? `user:${event.userId}` : `organization:${event.organizationId}`,
        event: event.event,
        groups: event.organizationId ? { organization: event.organizationId } : {},
        properties: { scope: config?.scope, event_id: event.id, ...event.properties },
      });
    },
    exception: (error: Error) => {
      sdk?.captureException(error, `${config?.scope}:control-plane`, {
        $process_person_profile: false,
      });
    },
    close: async () => {
      try {
        await sdk?.shutdown(1500);
      } catch {
        // Analytics delivery must not fail the application request.
      }
    },
  } satisfies Observation;
};
