import { waitUntil } from "cloudflare:workers";
import { PostHog } from "posthog-node/edge";
import type { WorkerIdentity } from "./runtime-extension.ts";
import type { ParentEnvironment } from "./types.ts";

export const reportRuntimeException = (
  cause: unknown,
  environment: ParentEnvironment,
  context: Partial<WorkerIdentity> & { operation: string },
) => {
  const token = environment.POSTHOG_PROJECT_TOKEN;

  if (!token) return;
  waitUntil(
    Promise.resolve()
      .then(async () => {
        const scope = environment.POSTHOG_SCOPE ?? "installation";

        const client = new PostHog(token, {
          host: "https://eu.i.posthog.com",
          flushAt: 1,
          flushInterval: 0,
          requestTimeout: 1500,
          fetchRetryCount: 0,
        });

        client.captureException(
          cause instanceof Error ? cause : new Error(String(cause)),
          `${scope}:app-runtime`,
          {
            $process_person_profile: false,
            $groups: context.organizationId ? { organization: context.organizationId } : undefined,
            scope,
            service: "app-runtime",
            operation: context.operation,
            app_id: context.appId,
            deployment_id: context.deploymentId,
            build_id: context.buildId,
          },
        );
        await client.shutdown(1500);
      })
      .catch(() => {
        // Reporting must not replace the original runtime failure.
      }),
  );
};
