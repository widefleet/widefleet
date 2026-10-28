import posthog from "posthog-js";
import { z } from "zod";
import type { PostHog, PostHogConfig, CaptureResult } from "posthog-js";
import type { AnalyticsConfiguration } from "./analytics-config.ts";

export interface ClientContext {
  user: { id: string } | null;
  organization: { id: string; name: string } | null;
  role: string | null;
  route: string | null;
  url: string;
  analytics: AnalyticsConfiguration | null;
}

type Analytics = Pick<
  PostHog,
  | "identify"
  | "group"
  | "reset"
  | "resetGroups"
  | "register"
  | "capture"
  | "captureException"
  | "startSessionRecording"
  | "stopSessionRecording"
  | "set_config"
  | "get_session_id"
  | "get_distinct_id"
  | "getGroups"
> & { init: (key: string, options: Partial<PostHogConfig>) => void };

export const routePath = (route: string | null) => route?.replace(/\/\([^/]+\)/g, "") || "/";

const pageLocation = (url: string) => url.replace(/[?#].*$/, "");

const allowedProperties = new Set([
  "distinct_id",
  "$anon_distinct_id",
  "$device_id",
  "$user_id",
  "$is_identified",
  "$process_person_profile",
  "$session_id",
  "$window_id",
  "$lib",
  "$lib_version",
  "$groups",
  "$group_type",
  "$group_key",
  "$group_set",
  "$exception_list",
  "$exception_level",
  "$snapshot_data",
  "$snapshot_bytes",
  "$snapshot_host",
  "$snapshot_source",
  "$browser",
  "$browser_version",
  "$os",
  "$os_version",
  "$device_type",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
  "deployment",
  "scope",
  "organization_id",
  "organization_role",
  "route",
  "feature",
]);

export const sanitizeBrowserEvent = (event: CaptureResult, context: ClientContext | undefined) => {
  const config = context?.analytics;

  if (!config || !context?.user || !context.organization) return null;

  const properties = Object.fromEntries(
    Object.entries(event.properties).filter(
      ([key]) => allowedProperties.has(key) || /^\$web_vitals_(LCP|CLS|FCP|INP)_value$/.test(key),
    ),
  );

  // Drop SDK-generated referrers, page titles, campaign params and initial URL person properties.
  delete event.$set;
  delete event.$set_once;
  delete event.$unset;

  return {
    ...event,
    properties: {
      ...properties,
      token: config.projectToken,
      distinct_id: `user:${context.user.id}`,
      deployment: config.scope,
      scope: config.scope,
      $groups: { organization: context.organization.id },
      organization_id: context.organization.id,
      organization_role: context.role,
      route: routePath(context.route),
      $current_url: `${config.origin}${routePath(context.route)}`,
      $pathname: routePath(context.route),
      $geoip_disable: true,
    },
  };
};

export const createBrowserAnalytics = (sdk: Analytics, origin: () => string) => {
  let started = false;
  let initialized = false;
  let context: ClientContext | undefined;
  let identity: string | undefined;
  let organization: string | undefined;
  let page: string | undefined;
  let errorWindow = 0;
  let errorCount = 0;
  const sessions = new Map<string, ClientContext>();
  const routes = new Map<string, string | null>();

  const rememberSession = (id: string, value: ClientContext) => {
    sessions.set(id, value);

    if (sessions.size > 8) {
      const oldest = sessions.keys().next().value;

      if (oldest) sessions.delete(oldest);
    }
  };

  const beforeSend = (event: CaptureResult) => {
    const sessionId = z.string().safeParse(event.properties["$session_id"]).data;

    const eventContext =
      sessionId !== undefined
        ? (sessions.get(sessionId) ?? (sessionId === sdk.get_session_id() ? context : undefined))
        : context;

    if (sessionId !== undefined && eventContext && !sessions.has(sessionId))
      rememberSession(sessionId, eventContext);

    if (event.event === "$web_vitals") {
      // Metrics can flush after navigation. Use the URL retained by the SDK,
      // while sending only the route template associated with that page.
      const url = z.string().safeParse(event.properties["$current_url"]).data;
      const route = url !== undefined ? routes.get(pageLocation(url)) : undefined;

      if (!eventContext || route === undefined) return null;

      return sanitizeBrowserEvent(event, { ...eventContext, route });
    }

    return sanitizeBrowserEvent(event, eventContext);
  };

  const clearIdentity = (nextUserId?: string) => {
    if (initialized) {
      sdk.stopSessionRecording();
      sdk.set_config({ capture_performance: false });

      if (nextUserId)
        sdk.reset({
          resetDeviceID: true,
          bootstrap: { distinctID: `user:${nextUserId}`, isIdentifiedID: true },
        });
      else sdk.reset(true);
      sdk.resetGroups();
    }

    identity = undefined;
    organization = undefined;
    page = undefined;
    context = undefined;
  };

  const update = (value: ClientContext) => {
    const next = structuredClone(value);
    const previousIdentity = identity;
    const previousOrganization = organization;
    const config = next.analytics;

    if (!started || !config || origin() !== config.origin) {
      if (identity) clearIdentity();
      context = next;

      return;
    }

    if (!next.user || !next.organization) {
      if (identity) clearIdentity();
      context = next;

      return;
    }

    if (
      (identity && identity !== next.user.id) ||
      (organization && organization !== next.organization.id)
    ) {
      clearIdentity(next.user.id);
    }

    context = next;
    const location = pageLocation(next.url);
    routes.set(location, next.route);

    if (!initialized) {
      const options: Partial<PostHogConfig> = {
        api_host: config.proxyPath,
        ui_host: config.uiOrigin,
        defaults: "2026-08-30",
        persistence: "localStorage+cookie",
        cross_subdomain_cookie: false,
        save_campaign_params: false,
        save_referrer: false,
        person_profiles: "identified_only",
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_exceptions: false,
        capture_performance: {
          web_vitals: true,
          network_timing: false,
          web_vitals_attribution: false,
        },
        disable_session_recording: true,
        enable_recording_console_log: false,
        enable_heatmaps: false,
        capture_dead_clicks: false,
        rageclick: false,
        disable_surveys: true,
        disable_product_tours: true,
        opt_in_site_apps: false,
        advanced_disable_feature_flags: true,
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: "*",
          maskAttributeFn: () => "",
          blockSelector:
            "img, canvas, video, audio, iframe, pre, code, [contenteditable], .monaco-editor, .cm-editor, [data-sensitive]",
          recordHeaders: false,
          recordBody: false,
          recordCrossOriginIframes: false,
          captureCanvas: { recordCanvas: false },
          captureJsonLd: false,
          maskCapturedNetworkRequestFn: (request) => ({
            ...request,
            name: `${config.origin}${routePath(context?.route ?? null)}`,
          }),
        },
        before_send: beforeSend,
      };

      sdk.init(config.projectToken, options);
      initialized = true;
    }

    const persistedUser = sdk.get_distinct_id();
    const persistedOrganization = z.string().safeParse(sdk.getGroups()["organization"]).data;

    if (
      (persistedUser.startsWith("user:") && persistedUser !== `user:${next.user.id}`) ||
      (persistedOrganization && persistedOrganization !== next.organization.id)
    ) {
      clearIdentity(next.user.id);
      context = next;
    }

    // Recorder batches can flush after reset. Keep their original identity and
    // organization even when the active workspace has already changed.
    rememberSession(sdk.get_session_id(), next);

    if (identity !== next.user.id) {
      identity = next.user.id;
      sdk.identify(`user:${identity}`);
    }

    if (organization !== next.organization.id) {
      organization = next.organization.id;
      sdk.group("organization", organization, { name: next.organization.name });
    }

    sdk.register({
      deployment: config.scope,
      scope: config.scope,
      organization_id: organization,
      organization_role: next.role,
      route: routePath(next.route),
    });

    if (previousIdentity !== identity || previousOrganization !== organization) {
      sdk.set_config({
        capture_performance: {
          web_vitals: true,
          network_timing: false,
          web_vitals_attribution: false,
        },
      });

      if (config.sessionReplay) sdk.startSessionRecording();
    }

    const key = `${identity}:${organization}:${location}`;

    if (page !== key) {
      page = key;
      sdk.capture("$pageview");
      const feature = routePath(next.route).split("/")[1] || "apps";

      if (["apps", "connectors", "members", "settings", "agents", "catalog"].includes(feature))
        sdk.capture("feature_viewed", { feature });
    }
  };

  return {
    start: () => {
      started = true;

      if (context) update(context);

      return () => {
        if (initialized) {
          sdk.stopSessionRecording();
          sdk.set_config({ capture_performance: false });
        }

        identity = undefined;
        organization = undefined;
        page = undefined;
        started = false;
      };
    },
    update,
    reset: () => clearIdentity(),
    exception: (error: Error) => {
      if (!started || !identity || !context?.user || !initialized) return;

      if (Date.now() - errorWindow >= 60_000) {
        errorWindow = Date.now();
        errorCount = 0;
      }

      if (errorCount >= 5) return;
      errorCount += 1;
      sdk.captureException(error);
    },
  };
};

export const browserAnalytics = createBrowserAnalytics(posthog, () => window.location.origin);
