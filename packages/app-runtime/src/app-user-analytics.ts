import { waitUntil } from "cloudflare:workers";
import { PostHog } from "posthog-node/edge";
import { appUserDistinctId } from "@platform/contracts";
import type { ParentEnvironment } from "./types.ts";

export interface AppUserActivity {
  trigger: "sign_in" | "renewal" | "embedded_sign_in" | "mcp_sign_in" | "mcp_renewal";
  organizationId: string;
  appId?: string;
  issuer: string;
  identity: { id: string; name: string; email: string };
}

/**
 * Sends app sign-ins and session renewals to the installation's PostHog project, when one
 * is configured. Browser sessions renew with the identity provider's token lifetime and MCP
 * access tokens last at most five minutes, so an active person produces one event per
 * renewal instead of one per request.
 */
export const appUserAnalytics = (environment: ParentEnvironment) => {
  const token = environment.POSTHOG_PROJECT_TOKEN;

  if (!token) return undefined;
  const scope = environment.POSTHOG_SCOPE ?? "installation";

  return (activity: AppUserActivity) =>
    waitUntil(
      Promise.resolve()
        .then(async () => {
          const client = new PostHog(token, {
            host: "https://eu.i.posthog.com",
            flushAt: 1,
            flushInterval: 0,
            requestTimeout: 1500,
            fetchRetryCount: 0,
          });

          client.capture({
            // The provider's subject is the stable account; email addresses can change.
            distinctId: await appUserDistinctId({
              issuer: activity.issuer,
              subject: activity.identity.id,
            }),
            event: "app_user_active",
            groups: { organization: activity.organizationId },
            properties: {
              scope,
              service: "app-runtime",
              trigger: activity.trigger,
              // Serialization omits the app for sign-ins, which happen on the auth host.
              app_id: activity.appId,
              $set: { name: activity.identity.name, email: activity.identity.email },
            },
          });
          await client.shutdown(1500);
        })
        .catch(() => {
          // Analytics delivery must not affect sign-in or app requests.
        }),
    );
};
