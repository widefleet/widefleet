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
    getGroups: vi.spyOn(posthog, "getGroups").mockReturnValue({ organization: "org-a" }),
  };
};

let sdk: Awaited<ReturnType<typeof spySdk>>;

let analytics: typeof import("../src/lib/analytics-client.ts");

const context = {
  analytics: config,
  user: { id: "a" },
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

it("stays inactive without configuration, on previews and before sign-in", () => {
  analytics.updateClientContext({ ...context, analytics: null });
  analytics.updateClientContext({ ...context, user: null });
  vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  analytics.updateClientContext(context);
  analytics.captureBrowserException(new Error("Unconfigured"));
  expect(sdk.init).not.toHaveBeenCalled();
  expect(sdk.captureException).not.toHaveBeenCalled();
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
  expect(sdk.identify).toHaveBeenCalledWith("user:a");
  expect(sdk.group).toHaveBeenCalledWith("organization", "org-a", { name: "Alpha" });
  expect(sdk.reset).not.toHaveBeenCalled();
  analytics.updateClientContext({ ...context, role: "owner" });
  expect(sdk.init).toHaveBeenCalledOnce();
  expect(sdk.capture).not.toHaveBeenCalled();
});

it("resets account/organization transitions and clears identity on logout", () => {
  analytics.updateClientContext(context);
  analytics.updateClientContext({ ...context, organization: { id: "org-b", name: "Beta" } });
  analytics.updateClientContext({ ...context, user: { id: "b" } });
  expect(sdk.reset).toHaveBeenCalledTimes(2);
  expect(sdk.identify).toHaveBeenLastCalledWith("user:b");
  analytics.resetClientContext();
  expect(sdk.reset).toHaveBeenCalledTimes(3);
});

it("passes original errors and enables replay only when configured", () => {
  analytics.updateClientContext({ ...context, analytics: { ...config, sessionReplay: false } });
  const error = new Error("Original message", { cause: new Error("Original cause") });
  analytics.captureBrowserException(error);
  expect(sdk.captureException).toHaveBeenCalledWith(error);
  expect(sdk.init.mock.calls[0]?.[1]?.disable_session_recording).toBe(true);
});
