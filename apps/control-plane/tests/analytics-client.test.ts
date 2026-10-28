import { describe, expect, it, vi } from "vitest";
import type { PostHog, PostHogConfig } from "posthog-js";
import type { ClientContext } from "../src/lib/analytics-client.ts";
import { createBrowserAnalytics, sanitizeBrowserEvent } from "../src/lib/analytics-client.ts";
import { analyticsConfiguration as config } from "./analytics-fixture.ts";

const context: ClientContext = {
  analytics: config,
  user: { id: "user-a" },
  organization: { id: "org-a", name: "Synthetic organization" },
  role: "member",
  route: "/(workspace)/apps/[id]",
  url: `${config.origin}/apps/private-name?token=secret#secret`,
};

const fixture = (origin = config.origin) => {
  const sdk = {
    init: vi.fn<(_key: string, _options?: Partial<PostHogConfig>) => undefined>(),
    identify: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
    resetGroups: vi.fn(),
    register: vi.fn(),
    capture: vi.fn<(_event: string, _properties?: Parameters<PostHog["capture"]>[1]) => undefined>(
      () => undefined,
    ),
    captureException: vi.fn<(_error: Error) => undefined>(() => undefined),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
    set_config: vi.fn(),
    get_session_id: vi.fn(() => "session-a"),
    get_distinct_id: vi.fn(() => "user:user-a"),
    getGroups: vi.fn<() => Record<string, string>>(() => ({})),
  };

  return { sdk, extension: createBrowserAnalytics(sdk, () => origin) };
};

describe("Browser product analytics", () => {
  it("keeps the SDK inactive without deployment configuration", () => {
    const { sdk, extension } = fixture();
    extension.start();
    extension.update({ ...context, analytics: null });
    extension.exception(new Error("Unconfigured installation"));
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it("records only when replay is explicitly enabled", () => {
    const { sdk, extension } = fixture();
    extension.start();
    extension.update({ ...context, analytics: { ...config, sessionReplay: false } });
    expect(sdk.init).toHaveBeenCalled();
    expect(sdk.capture).toHaveBeenCalledWith("$pageview");
    expect(sdk.startSessionRecording).not.toHaveBeenCalled();
  });

  it("starts only for an authenticated organization on the configured origin", () => {
    const { sdk, extension } = fixture();
    extension.update?.(context);
    expect(sdk.init).not.toHaveBeenCalled();
    extension.start?.();
    expect(sdk.identify).toHaveBeenCalledWith("user:user-a");
    expect(sdk.group).toHaveBeenCalledWith("organization", "org-a", {
      name: "Synthetic organization",
    });
    const local = fixture("http://localhost");
    local.extension.start?.();
    local.extension.update?.(context);
    expect(local.sdk.init).not.toHaveBeenCalled();
  });

  it("splits replays when organization or account changes and clears identity on logout", () => {
    const { sdk, extension } = fixture();
    extension.start?.();
    extension.update?.(context);
    extension.update?.({ ...context, organization: { id: "org-b", name: "Second organization" } });
    expect(sdk.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(sdk.reset).toHaveBeenCalledWith({
      resetDeviceID: true,
      bootstrap: { distinctID: "user:user-a", isIdentifiedID: true },
    });
    expect(sdk.group).toHaveBeenLastCalledWith("organization", "org-b", {
      name: "Second organization",
    });
    extension.update?.({ ...context, user: { id: "user-b" } });
    expect(sdk.identify).toHaveBeenLastCalledWith("user:user-b");
    extension.reset?.();
    const captures = sdk.capture.mock.calls.length;
    extension.update?.({ ...context, user: null, organization: null });
    extension.exception?.(new Error("Logged out"));
    expect(sdk.capture.mock.calls).toHaveLength(captures);
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it("does not duplicate page events when workspace data refreshes", () => {
    const { sdk, extension } = fixture();
    extension.start?.();
    extension.update?.(context);
    const captures = sdk.capture.mock.calls.length;
    extension.update?.({ ...context, role: "owner" });
    expect(sdk.capture.mock.calls).toHaveLength(captures);
    expect(sdk.register).toHaveBeenLastCalledWith(
      expect.objectContaining({ organization_role: "owner" }),
    );
  });

  it("counts different app paths on the same route without counting query or data refreshes", () => {
    const { sdk, extension } = fixture();
    extension.start?.();
    extension.update?.(context);
    const parent = { ...context, url: `${config.origin}/apps/parent-name` };
    extension.update?.(parent);
    extension.update?.({ ...parent, role: "owner" });
    extension.update?.({ ...parent, url: `${parent.url}?tab=overview#section` });
    expect(sdk.capture.mock.calls.filter(([event]) => event === "$pageview")).toHaveLength(2);
    expect(sdk.capture.mock.calls.filter(([event]) => event === "feature_viewed")).toHaveLength(2);
    const beforeSend = sdk.init.mock.calls[0]?.[1]?.before_send;

    if (!beforeSend || Array.isArray(beforeSend)) throw new Error("Missing event sanitizer");
    const event = beforeSend({ uuid: crypto.randomUUID(), event: "$pageview", properties: {} });
    expect(event?.properties["$current_url"]).toBe(`${config.origin}/apps/[id]`);
    expect(JSON.stringify(event)).not.toContain("parent-name");
  });

  it("attributes delayed Web Vitals to the measured page after navigation", () => {
    const { sdk, extension } = fixture();
    extension.start?.();
    extension.update?.(context);
    extension.update?.({
      ...context,
      route: "/(workspace)/settings",
      url: `${config.origin}/settings`,
    });
    const beforeSend = sdk.init.mock.calls[0]?.[1]?.before_send;

    if (!beforeSend || Array.isArray(beforeSend)) throw new Error("Missing event sanitizer");

    const event = beforeSend({
      uuid: crypto.randomUUID(),
      event: "$web_vitals",
      properties: {
        $session_id: "session-a",
        $current_url: context.url,
        $web_vitals_LCP_value: 1200,
      },
    });

    expect(event?.properties).toMatchObject({
      route: "/apps/[id]",
      $current_url: `${config.origin}/apps/[id]`,
      $pathname: "/apps/[id]",
      $web_vitals_LCP_value: 1200,
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("private-name");
    expect(
      beforeSend({
        uuid: crypto.randomUUID(),
        event: "$web_vitals",
        properties: { $current_url: `${config.origin}/unknown` },
      }),
    ).toBeNull();
  });

  it("flushes the old replay with its original organization before switching", () => {
    const { sdk, extension } = fixture();
    extension.start?.();
    extension.update?.(context);
    const beforeSend = sdk.init.mock.calls[0]?.[1]?.before_send;

    if (!beforeSend || Array.isArray(beforeSend)) throw new Error("Missing event sanitizer");
    sdk.stopSessionRecording.mockImplementation(() => {
      const event = beforeSend({ uuid: crypto.randomUUID(), event: "$snapshot", properties: {} });
      expect(event?.properties["$groups"]).toEqual({ organization: "org-a" });
    });
    sdk.get_session_id.mockReturnValue("session-b");
    extension.update?.({ ...context, organization: { id: "org-b", name: "Second organization" } });
    const event = beforeSend({ uuid: crypto.randomUUID(), event: "$snapshot", properties: {} });
    expect(event?.properties["$groups"]).toEqual({ organization: "org-b" });

    const buffered = beforeSend({
      uuid: crypto.randomUUID(),
      event: "$snapshot",
      properties: { $session_id: "session-a" },
    });

    expect(buffered?.properties["$groups"]).toEqual({ organization: "org-a" });
    expect(buffered?.properties["distinct_id"]).toBe("user:user-a");
  });

  it("uses the first-party endpoint and masks content, attributes and replay URLs", () => {
    const { sdk, extension } = fixture();
    extension.start?.();
    extension.update?.(context);
    const options = sdk.init.mock.calls[0]?.[1];
    expect(options?.api_host).toBe("/analytics");
    expect(options?.session_recording).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: "*",
      recordBody: false,
      recordHeaders: false,
      captureCanvas: { recordCanvas: false },
    });
    expect(options?.session_recording?.maskAttributeFn?.("title", "secret")).toBe("");
    expect(options?.session_recording?.maskAttributeFn?.("class", "secret")).toBe("");
    expect(options?.session_recording?.maskAttributeFn?.("href", "/?token=secret")).toBe("");
    expect(
      options?.session_recording?.maskCapturedNetworkRequestFn?.({
        name: context.url,
        duration: 0,
        startTime: 0,
        entryType: "navigation",
      })?.name,
    ).toBe(`${config.origin}/apps/[id]`);
  });

  it("removes titles, referrers, URL parameters, initial person properties and Web Vitals DOM attribution", () => {
    const result = sanitizeBrowserEvent(
      {
        uuid: crypto.randomUUID(),
        event: "$web_vitals",
        $set: { email: "secret@example.test" },
        $set_once: { $initial_current_url: context.url },
        properties: {
          distinct_id: "user:user-a",
          $current_url: context.url,
          $title: "secret",
          $referrer: context.url,
          $web_vitals_LCP_value: 123,
          $web_vitals_LCP_event: { element: "secret" },
          $groups: { organization: "org-a" },
        },
      },
      context,
    );

    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result?.properties).toMatchObject({
      token: config.projectToken,
      $web_vitals_LCP_value: 123,
      $groups: { organization: "org-a" },
    });
  });

  it("passes the original exception, including its message, stack and cause, to the SDK", () => {
    const { sdk, extension } = fixture();
    extension.start?.();
    extension.update?.(context);

    const error = new TypeError("Cannot read deployment status", {
      cause: new Error("Connection refused"),
    });

    for (let i = 0; i < 10; i++) extension.exception?.(error);
    expect(sdk.captureException).toHaveBeenCalledTimes(5);
    expect(sdk.captureException.mock.calls[0]?.[0]).toBe(error);
  });

  it("preserves persisted sessions through startup and cleanup", () => {
    const { sdk, extension } = fixture();
    sdk.getGroups.mockReturnValue({ organization: "org-a" });
    extension.update?.(context);
    const stop = extension.start?.();
    expect(sdk.init.mock.calls[0]?.[1]).toMatchObject({ persistence: "localStorage+cookie" });
    expect(sdk.init.mock.calls[0]?.[1]?.bootstrap).toBeUndefined();

    stop();
    extension.start?.();
    expect(sdk.reset).not.toHaveBeenCalled();
    expect(sdk.resetGroups).not.toHaveBeenCalled();
  });

  it.each(["user", "organization"])("resets a different persisted %s on startup", (changed) => {
    const { sdk, extension } = fixture();
    sdk.get_distinct_id.mockReturnValue(changed === "user" ? "user:previous" : "user:user-a");
    sdk.getGroups.mockReturnValue({
      organization: changed === "organization" ? "previous" : "org-a",
    });
    extension.start?.();
    extension.update?.(context);
    expect(sdk.reset).toHaveBeenCalledOnce();
    expect(sdk.identify).toHaveBeenLastCalledWith("user:user-a");
    expect(sdk.group).toHaveBeenLastCalledWith("organization", "org-a", {
      name: "Synthetic organization",
    });
  });
});
