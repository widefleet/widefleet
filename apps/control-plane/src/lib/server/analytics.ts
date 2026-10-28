import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";
import type { Observation, ObservationEvent } from "./observation.ts";
import type { AnalyticsEnvironment } from "../analytics-config.ts";
import { readAnalyticsConfiguration } from "../analytics-config.ts";

export const createProductAnalytics = (
  configuration: AnalyticsEnvironment & { PLATFORM_URL: string },
  transport: typeof fetch = fetch,
) => {
  let closed = false;
  const config = readAnalyticsConfiguration(configuration);
  const enabled = config && configuration.PLATFORM_URL === config.origin;

  const sdk = enabled
    ? new PostHog(config.projectToken, {
        host: config.ingestOrigin,
        flushAt: 20,
        maxBatchSize: 20,
        maxQueueSize: 20,
        flushInterval: 10_000,
        requestTimeout: 1500,
        fetchRetryCount: 0,
        disableGeoip: true,
        enableExceptionAutocapture: false,
        enableLocalEvaluation: false,
        disableCompression: true,
        fetch: (url, options) => transport(url, { ...options, redirect: "error" }),
      })
    : undefined;

  sdk?.on("error", () => {});
  const groups = new Set<string>();

  const append = (
    event: string,
    distinctId: string,
    properties: NonNullable<Parameters<PostHog["capture"]>[0]["properties"]>,
    id: string = crypto.randomUUID(),
  ) => {
    if (!sdk || !config || closed) return;
    const hash = createHash("sha256").update(`${event}:${id}`).digest("hex");
    const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    sdk.capture({
      distinctId,
      uuid,
      event,
      properties: {
        deployment: config.scope,
        scope: config.scope,
        $geoip_disable: true,
        ...properties,
      },
    });
  };

  return {
    capture: (event: ObservationEvent) => {
      if (!event.userId && !event.organizationId) return;

      if (event.organizationId && !groups.has(event.organizationId)) {
        groups.add(event.organizationId);
        append(
          "$groupidentify",
          event.userId ? `user:${event.userId}` : `organization:${event.organizationId}`,
          {
            $group_type: "organization",
            $group_key: event.organizationId,
            $group_set: {},
            $process_person_profile: Boolean(event.userId),
          },
        );
      }

      const properties: NonNullable<Parameters<PostHog["capture"]>[0]["properties"]> = {
        $process_person_profile: Boolean(event.userId),
        ...event.properties,
      };

      if (event.organizationId) {
        properties["$groups"] = { organization: event.organizationId };
        properties["organization_id"] = event.organizationId;
      }

      append(
        event.event,
        event.userId ? `user:${event.userId}` : `organization:${event.organizationId}`,
        properties,
        event.id,
      );
    },
    exception: (error: Error) => {
      if (!sdk || !config || closed) return;
      sdk.captureException(error, `${config.scope}:control-plane`, {
        $process_person_profile: false,
        deployment: config.scope,
        scope: config.scope,
        component: "server",
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;

      try {
        await sdk?.shutdown(1500);
      } catch {
        /* Observation cannot affect an application operation or response. */
      }
    },
  } satisfies Observation;
};
