import { describe, expect, it, vi } from "vitest";
import { proxyAnalyticsRequest as proxy } from "../src/lib/server/analytics-proxy.ts";
import { analyticsConfiguration as config } from "./analytics-fixture.ts";

const proxyAnalyticsRequest = (request: Request, transport: typeof fetch) =>
  proxy(request, config, transport);

const request = (path: string, init?: RequestInit) => new Request(`${config.origin}${path}`, init);

describe("Analytics proxy", () => {
  it.each([
    ["/analytics/e/", "https://eu.i.posthog.com/e/"],
    ["/analytics/s/", "https://eu.i.posthog.com/s/"],
    ["/analytics/flags/", "https://eu.i.posthog.com/flags/"],
    ["/analytics/static/recorder.js", "https://eu-assets.i.posthog.com/static/recorder.js"],
    [
      `/analytics/array/${config.projectToken}/config.js`,
      `${config.assetOrigin}/array/${config.projectToken}/config.js`,
    ],
  ])("routes %s to its fixed EU upstream", async (path, destination) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    expect((await proxyAnalyticsRequest(request(`${path}?v=1`), transport))?.status).toBe(200);
    expect(transport.mock.calls[0]?.[0]).toEqual(new URL(`${destination}?v=1`));
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("forwards payloads without application credentials or upstream cookies", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("ok", {
        headers: {
          "set-cookie": "upstream=secret",
          "access-control-allow-origin": "*",
          "content-type": "application/json",
        },
      }),
    );

    const response = await proxyAnalyticsRequest(
      request("/analytics/e/", {
        method: "POST",
        body: "synthetic-events",
        headers: {
          cookie: "session=secret",
          authorization: "Bearer secret",
          "x-forwarded-for": "10.0.0.1",
          "cf-connecting-ip": "10.0.0.2",
          referer: `${config.origin}/?token=secret`,
          "content-type": "text/plain",
          origin: config.origin,
        },
      }),
      transport,
    );

    const options = transport.mock.calls[0]?.[1];
    expect(Object.fromEntries(new Headers(options?.headers))).toEqual({
      "content-type": "text/plain",
      "accept-encoding": "identity",
    });
    expect(await new Response(options?.body).text()).toBe("synthetic-events");
    expect(response?.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    "/analytics/api/users",
    "/analytics//evil.test/e/",
    "/analytics/static/%2e%2e/private.js",
  ])("rejects unrecognized path %s without fetching", async (path) => {
    const transport = vi.fn<typeof fetch>();
    expect((await proxyAnalyticsRequest(request(path), transport))?.status).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not intercept unrelated paths or serve local-development traffic", async () => {
    const transport = vi.fn<typeof fetch>();
    expect(await proxy(request("/analytics/e/"), null, transport)).toBeUndefined();
    expect(await proxyAnalyticsRequest(request("/analytics-other"), transport)).toBeUndefined();
    expect(
      (await proxyAnalyticsRequest(new Request("http://localhost/analytics/e/"), transport))
        ?.status,
    ).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects redirect responses without following their destination", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://untrusted.example/e/" },
      }),
    );

    expect((await proxyAnalyticsRequest(request("/analytics/e/"), transport))?.status).toBe(502);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("fails closed when the upstream redirects or is unavailable", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    expect((await proxyAnalyticsRequest(request("/analytics/e/"), transport))?.status).toBe(502);
  });
});
