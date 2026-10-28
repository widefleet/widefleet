import posthog from "posthog-js";
import { z } from "zod";
import type { AnalyticsConfiguration } from "./analytics-config.ts";

export interface ClientContext {
  user: { id: string } | null;
  organization: { id: string; name: string } | null;
  role: string | null;
  url: string;
  analytics: AnalyticsConfiguration | null;
}

let initialized = false;

let active = false;

let lastPage: string | undefined;

export const resetClientContext = () => {
  if (!initialized) return;
  posthog.stopSessionRecording();
  posthog.reset();
  active = false;
  lastPage = undefined;
};

export const updateClientContext = ({
  user,
  organization,
  role,
  url,
  analytics,
}: ClientContext) => {
  if (!analytics || window.location.origin !== analytics.origin) return;

  if (!user || !organization) {
    if (active) resetClientContext();

    return;
  }

  if (!initialized) {
    posthog.init(analytics.projectToken, {
      api_host: analytics.proxyPath,
      ui_host: analytics.uiOrigin,
      defaults: "2026-08-30",
      persistence: "localStorage+cookie",
      cross_subdomain_cookie: false,
      autocapture: false,
      capture_pageview: false,
      capture_exceptions: false,
      capture_performance: { web_vitals: true, web_vitals_attribution: false },
      disable_session_recording: true,
      enable_recording_console_log: false,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
        maskAttributeFn: () => "",
        blockSelector:
          "img, canvas, video, audio, iframe, pre, code, [contenteditable], .monaco-editor, .cm-editor, [data-sensitive]",
        recordBody: false,
        recordHeaders: false,
      },
      before_send: (event) => {
        for (const key of ["$current_url", "$referrer"]) {
          const value = z.string().safeParse(event.properties[key]).data;

          if (value) event.properties[key] = value.replace(/[?#].*$/, "");
        }

        return event;
      },
    });
    initialized = true;
  }

  const distinctId = `user:${user.id}`;
  const previousUser = posthog.get_distinct_id();
  const previousOrganization = z.string().safeParse(posthog.getGroups()["organization"]).data;

  if (
    (previousUser.startsWith("user:") && previousUser !== distinctId) ||
    (previousOrganization && previousOrganization !== organization.id)
  )
    resetClientContext();

  posthog.identify(distinctId);
  posthog.group("organization", organization.id, { name: organization.name });
  posthog.register({ scope: analytics.scope, organization_role: role });

  if (!active && analytics.sessionReplay) posthog.startSessionRecording();
  active = true;

  const location = new URL(url);
  const page = `${distinctId}:${organization.id}:${location.pathname}`;

  if (lastPage !== page) {
    lastPage = page;
    posthog.capture("$pageview", { $current_url: `${location.origin}${location.pathname}` });
    const feature = location.pathname.split("/")[1];

    if (
      feature &&
      ["apps", "connectors", "members", "settings", "agents", "catalog"].includes(feature)
    )
      posthog.capture("feature_viewed", { feature });
  }
};

export const captureBrowserException = (error: Error) => {
  if (active) posthog.captureException(error);
};
