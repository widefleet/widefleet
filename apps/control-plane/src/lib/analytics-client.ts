import posthog from "posthog-js";
import type { AnalyticsConfiguration } from "./analytics-config.ts";

export interface ClientContext {
  user: { id: string } | null;
  organization: { id: string; name: string } | null;
  role: string | null;
  analytics: AnalyticsConfiguration | null;
}

let initialized = false;

export const resetClientContext = () => {
  if (initialized) posthog.reset();
};

export const updateClientContext = ({ user, organization, role, analytics }: ClientContext) => {
  if (!analytics || window.location.origin !== analytics.origin) return;

  if (!user || !organization) {
    if (initialized && posthog.get_distinct_id().startsWith("user:")) resetClientContext();

    return;
  }

  if (!initialized) {
    posthog.init(analytics.projectToken, {
      api_host: analytics.proxyPath,
      ui_host: analytics.uiOrigin,
      defaults: "2026-08-30",
      capture_exceptions: true,
      capture_performance: { web_vitals: true },
      disable_session_recording: !analytics.sessionReplay,
    });
    initialized = true;
  }

  const distinctId = `user:${user.id}`;
  const previousUser = posthog.get_distinct_id();
  const previousOrganization: unknown = posthog.getGroups()["organization"];

  if (
    (previousUser.startsWith("user:") && previousUser !== distinctId) ||
    (previousOrganization && previousOrganization !== organization.id)
  )
    resetClientContext();

  posthog.identify(distinctId);
  posthog.group("organization", organization.id, { name: organization.name });
  posthog.register({ scope: analytics.scope, organization_role: role });
};

export const captureBrowserException = (error: Error) => {
  if (initialized) posthog.captureException(error);
};
