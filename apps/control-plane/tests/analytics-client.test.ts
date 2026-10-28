import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { analyticsConfiguration as config } from "./analytics-fixture.ts";

const spySdk = async () => {
  const { default: posthog } = await import("posthog-js");

  return {
    init: vi.spyOn(posthog, "init").mockReturnValue(posthog),
    identify: vi.spyOn(posthog, "identify").mockImplementation(() => {}),
    group: vi.spyOn(posthog, "group").mockImplementation(() => {}),
    register: vi.spyOn(posthog, "register").mockImplementation(() => {}),
    capture: vi.spyOn(posthog, "capture").mockReturnValue(undefined),
    reset: vi.spyOn(posthog, "reset").mockImplementation(() => {}),
    captureException: vi.spyOn(posthog, "captureException").mockReturnValue(undefined),
    get_distinct_id: vi.spyOn(posthog, "get_distinct_id").mockReturnValue("user:a"),
  };
};

let sdk: Awaited<ReturnType<typeof spySdk>>;

let analytics: typeof import("../src/lib/analytics-client.ts");

const context = {
  analytics: config,
  user: { id: "a", name: "Alex Example", email: "alex@example.test" },
  organization: { id: "org-a", name: "Alpha" },
  role: "member",
};

beforeEach(async () => {
  vi.resetModules();
  sdk = await spySdk();
  vi.stubGlobal("window", { location: { origin: config.origin } });
  analytics = await import("../src/lib/analytics-client.ts");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("stays inactive without configuration and on previews", () => {
  analytics.updateClientContext({ ...context, analytics: null });
  vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  analytics.updateClientContext(context);
  analytics.captureBrowserException(new Error("Unconfigured"));
  expect(sdk.init).not.toHaveBeenCalled();
  expect(sdk.captureException).not.toHaveBeenCalled();
});

it("captures errors before sign-in or organization selection and identifies after entry", () => {
  sdk.get_distinct_id.mockReturnValue("anonymous-id");
  analytics.updateClientContext({ ...context, user: null, organization: null, role: null });
  const error = new Error("Sign-in failed");
  analytics.captureBrowserException(error);
  expect(sdk.init).toHaveBeenCalledOnce();
  expect(sdk.captureException).toHaveBeenCalledWith(error);
  expect(sdk.register).toHaveBeenCalledWith({ scope: config.scope });
  expect(sdk.identify).not.toHaveBeenCalled();
  expect(sdk.group).not.toHaveBeenCalled();

  analytics.updateClientContext({ ...context, organization: null });
  expect(sdk.init).toHaveBeenCalledOnce();
  expect(sdk.group).not.toHaveBeenCalled();
  analytics.updateClientContext(context);
  expect(sdk.identify).toHaveBeenCalledWith("user:a", {
    name: "Alex Example",
    email: "alex@example.test",
  });
  expect(sdk.group).toHaveBeenCalledWith("organization", "org-a", { name: "Alpha" });
  expect(sdk.reset).not.toHaveBeenCalled();
});

it("uses SDK defaults with only deployment and enabled-feature configuration", () => {
  analytics.updateClientContext(context);
  expect(sdk.init).toHaveBeenCalledWith(config.projectToken, {
    api_host: "/analytics",
    ui_host: config.uiOrigin,
    defaults: "2026-08-30",
    capture_exceptions: true,
    capture_performance: { web_vitals: true },
    disable_session_recording: false,
  });
  expect(sdk.identify).toHaveBeenCalledWith("user:a", {
    name: "Alex Example",
    email: "alex@example.test",
  });
  expect(sdk.group).toHaveBeenCalledWith("organization", "org-a", { name: "Alpha" });
  expect(sdk.reset).not.toHaveBeenCalled();
  analytics.updateClientContext({ ...context, role: "owner" });
  expect(sdk.init).toHaveBeenCalledOnce();
  expect(sdk.capture).not.toHaveBeenCalled();
});

it("preserves organization transitions and clears identified sessions without resetting anonymous visits", () => {
  analytics.updateClientContext(context);
  analytics.updateClientContext({ ...context, user: null, organization: null, role: null });
  expect(sdk.reset).not.toHaveBeenCalled();
  analytics.updateClientContext({
    ...context,
    organization: { id: "org-b", name: "Beta" },
    role: "owner",
  });
  expect(sdk.reset).not.toHaveBeenCalled();
  expect(sdk.identify).toHaveBeenLastCalledWith("user:a", {
    name: "Alex Example",
    email: "alex@example.test",
  });
  expect(sdk.group).toHaveBeenLastCalledWith("organization", "org-b", { name: "Beta" });
  expect(sdk.register).toHaveBeenLastCalledWith({
    scope: config.scope,
    organization_role: "owner",
  });
  analytics.updateClientContext({
    ...context,
    user: { id: "b", name: "Blair Example", email: "blair@example.test" },
  });
  expect(sdk.reset).toHaveBeenCalledOnce();
  expect(sdk.identify).toHaveBeenLastCalledWith("user:b", {
    name: "Blair Example",
    email: "blair@example.test",
  });
  analytics.resetClientContext();
  expect(sdk.reset).toHaveBeenCalledTimes(2);
  sdk.get_distinct_id.mockReturnValue("anonymous-id");
  analytics.resetClientContext();
  expect(sdk.reset).toHaveBeenCalledTimes(2);
});

it("updates profile properties without changing user identity or resetting the session", () => {
  analytics.updateClientContext(context);
  analytics.updateClientContext({
    ...context,
    user: { ...context.user, name: "Alex Updated", email: "updated@example.test" },
  });
  expect(sdk.identify).toHaveBeenLastCalledWith("user:a", {
    name: "Alex Updated",
    email: "updated@example.test",
  });
  expect(sdk.reset).not.toHaveBeenCalled();
});

it("passes original errors and enables replay only when configured", () => {
  analytics.updateClientContext({ ...context, analytics: { ...config, sessionReplay: false } });
  const error = new Error("Original message", { cause: new Error("Original cause") });
  analytics.captureBrowserException(error);
  expect(sdk.captureException).toHaveBeenCalledWith(error);
  expect(sdk.init.mock.calls[0]?.[1]?.disable_session_recording).toBe(true);
});
