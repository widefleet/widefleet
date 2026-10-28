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
    stopSessionRecording: vi.spyOn(posthog, "stopSessionRecording").mockImplementation(() => {}),
    startSessionRecording: vi.spyOn(posthog, "startSessionRecording").mockImplementation(() => {}),
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
  url: `${config.origin}/apps/first?token=secret`,
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

it("uses persistent identity, organization groups and masked replay through the proxy", () => {
  analytics.updateClientContext(context);
  expect(sdk.init).toHaveBeenCalledWith(
    config.projectToken,
    expect.objectContaining({
      api_host: "/analytics",
      persistence: "localStorage+cookie",
    }),
  );
  expect(sdk.init.mock.calls[0]?.[1]?.session_recording).toMatchObject({
    maskAllInputs: true,
    maskTextSelector: "*",
  });
  expect(sdk.identify).toHaveBeenCalledWith("user:a");
  expect(sdk.group).toHaveBeenCalledWith("organization", "org-a", { name: "Alpha" });
  expect(sdk.startSessionRecording).toHaveBeenCalledOnce();
  expect(sdk.reset).not.toHaveBeenCalled();
});

it("resets account/organization transitions and stops reporting after logout", () => {
  analytics.updateClientContext(context);
  analytics.updateClientContext({ ...context, organization: { id: "org-b", name: "Beta" } });
  analytics.updateClientContext({ ...context, user: { id: "b" } });
  expect(sdk.reset).toHaveBeenCalledTimes(2);
  expect(sdk.identify).toHaveBeenLastCalledWith("user:b");
  analytics.resetClientContext();
  analytics.captureBrowserException(new Error("Logged out"));
  expect(sdk.stopSessionRecording).toHaveBeenCalledTimes(3);
  expect(sdk.captureException).not.toHaveBeenCalled();
});

it("counts different pages once and preserves SDK event properties", () => {
  analytics.updateClientContext(context);
  analytics.updateClientContext({ ...context, role: "owner" });
  analytics.updateClientContext({ ...context, url: `${config.origin}/apps/second` });
  expect(sdk.capture.mock.calls.filter(([event]) => event === "$pageview")).toHaveLength(2);
  const beforeSend = sdk.init.mock.calls[0]?.[1]?.before_send;

  if (!beforeSend || Array.isArray(beforeSend)) throw new Error("Missing URL cleanup");
  expect(
    beforeSend({
      uuid: "fixture",
      event: "$web_vitals",
      properties: {
        $current_url: `${config.origin}/apps/first?token=secret`,
        $web_vitals_LCP_value: 123,
        custom: "kept",
      },
    })?.properties,
  ).toEqual({
    $current_url: `${config.origin}/apps/first`,
    $web_vitals_LCP_value: 123,
    custom: "kept",
  });
});

it("passes original errors and enables replay only when configured", () => {
  analytics.updateClientContext({ ...context, analytics: { ...config, sessionReplay: false } });
  const error = new Error("Original message", { cause: new Error("Original cause") });
  analytics.captureBrowserException(error);
  expect(sdk.captureException).toHaveBeenCalledWith(error);
  expect(sdk.startSessionRecording).not.toHaveBeenCalled();
});
