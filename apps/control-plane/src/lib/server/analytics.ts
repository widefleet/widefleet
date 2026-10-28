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
      if (!event.userId && !event.organizationId && !event.anonymousId) return;

      sdk?.capture({
        distinctId: event.userId
          ? `user:${event.userId}`
          : event.organizationId
            ? `organization:${event.organizationId}`
            : `anonymous:${event.anonymousId}`,
        event: event.event,
        groups: event.organizationId ? { organization: event.organizationId } : {},
        properties: {
          scope: config?.scope,
          event_id: event.id,
          ...event.properties,
          $process_person_profile:
            !event.userId && !event.organizationId
              ? false
              : event.properties?.["$process_person_profile"],
        },
      });
    },
    exception: (
      error: Error,
      distinctId?: string,
      properties?: Parameters<PostHog["captureException"]>[2],
    ) => {
      sdk?.captureException(error, distinctId ?? `${config?.scope}:control-plane`, {
        $process_person_profile: Boolean(distinctId),
        scope: config?.scope,
        ...properties,
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
