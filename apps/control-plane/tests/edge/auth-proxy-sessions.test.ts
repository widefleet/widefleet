import { authConfiguration, createAuthProxy } from "@platform/auth-proxy";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createIdentityProvider, tenantId } from "./auth-proxy-idp.ts";

const app = "https://ledger.apps.example.test/";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .flatMap((value) => (value.includes("Max-Age=0") ? [] : [value.split(";")[0]]))
    .join("; ");

describe("Auth proxy session lifecycle", () => {
  let idp: Awaited<ReturnType<typeof createIdentityProvider>>;
  let configuration: z.infer<typeof authConfiguration>;
  let cookie: string;
  let appFailure = false;
  const access = { revision: 0, groups: ["accounting"] };

  const apps = {
    resolve: (hostname: string) =>
      Promise.resolve(hostname === new URL(app).hostname ? access : null),
    fetch: (request: Request) =>
      appFailure
        ? Promise.reject(new Error("Fixture app unavailable"))
        : Promise.resolve(Response.json(Object.fromEntries(request.headers))),
  };

  const login = async () => {
    const proxy = createAuthProxy(configuration, apps);

    const started = await proxy.fetch(
      new Request(
        `https://auth.apps.example.test/oauth2/widefleet/start?rd=${encodeURIComponent(app)}`,
      ),
    );

    expect(started.status).toBe(302);

    const authorized = await fetch(z.url().parse(started.headers.get("location")), {
      redirect: "manual",
    });

    const completed = await proxy.fetch(
      new Request(z.url().parse(authorized.headers.get("location")), {
        headers: { cookie: cookies(started) },
      }),
    );

    expect(completed.headers.get("location")).toBe(app);

    return cookies(completed);
  };

  const visit = (settings = configuration, session = cookie) =>
    createAuthProxy(settings, apps).fetch(new Request(app, { headers: { cookie: session } }));

  beforeAll(async () => {
    idp = await createIdentityProvider();
    configuration = authConfiguration.parse({
      organizationId: "widefleet",
      provider: {
        type: "oidc",
        issuer: idp.origin,
        label: "Company",
        nameClaim: "display_name",
        emailClaim: "mail",
        groupsClaim: "roles",
      },
      clientId: "app-login",
      clientSecret: "synthetic-client-secret",
      cookieSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
      domain: "apps.example.test",
      redirectUrl: "https://auth.apps.example.test/oauth2/widefleet/callback",
    });
  });

  beforeEach(async () => {
    idp.settings.available = true;
    idp.settings.failure = "";
    idp.settings.refreshFailure = "";
    idp.settings.rotateRefreshTokens = true;
    appFailure = false;
    idp.settings.issueRefreshToken = true;
    idp.settings.omitRefreshIdToken = false;
    idp.settings.subject = "pairwise-subject";
    idp.settings.groups = ["accounting"];
    idp.settings.graphFailure = "";
    idp.refreshRequests.length = 0;
    cookie = await login();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    access.groups = ["accounting"];
    idp.settings.entra = false;
  });
  afterAll(async () => {
    await idp?.stop();
  });

  const expireIdentity = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
  };

  it("refreshes expired provider tokens and keeps a session usable across requests", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 59 * 60 * 1000);
    const accepted = await visit();

    expect(accepted.status).toBe(200);
    expect(accepted.headers.getSetCookie()).toEqual([]);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    const renewed = await visit();
    expect(renewed.status).toBe(200);
    expect(idp.refreshRequests).toHaveLength(1);
    const next = cookies(renewed);
    expect(next).toContain(".account_data=");
    expect(next).toContain(".session_data=");
    expect((await visit(configuration, next)).status).toBe(200);
    expect(idp.refreshRequests).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    expect((await visit(configuration, next)).status).toBe(200);
    expect(idp.refreshRequests).toHaveLength(2);
    expect(idp.refreshRequests[0]).not.toBe(idp.refreshRequests[1]);
  });

  it("uses newly verified groups and forwards renewal cookies even when access is denied", async () => {
    idp.settings.groups = ["reviewers"];
    expect((await visit()).status).toBe(200);
    expireIdentity();
    const denied = await visit();
    expect(denied.status).toBe(403);
    expect(denied.headers.getSetCookie().length).toBeGreaterThan(0);
    access.groups = ["reviewers"];
    const accepted = await visit(configuration, cookies(denied));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ "x-auth-request-groups": "reviewers" });
    expect(idp.refreshRequests).toHaveLength(1);
  });

  it("renews parallel app requests without forwarding provider credentials to apps", async () => {
    expireIdentity();
    const results = await Promise.all(Array.from({ length: 4 }, () => visit()));

    for (const result of results) {
      expect(result.status).toBe(200);
      const headers = z.record(z.string(), z.string()).parse(await result.json());
      expect(headers["cookie"]).toBeUndefined();
      expect(headers["authorization"]).toBeUndefined();
      expect((await visit(configuration, cookies(result))).status).toBe(200);
    }
  });

  it("preserves the login through a provider outage and retries on the next request", async () => {
    idp.settings.available = false;
    expect((await visit()).status).toBe(200);
    expireIdentity();
    const unavailable = await visit();
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.getSetCookie()).toEqual([]);
    idp.settings.available = true;
    expect((await visit()).status).toBe(200);
  });

  it("delivers rotated credentials even when the app throws", async () => {
    expireIdentity();
    appFailure = true;
    const failed = await visit();

    expect(failed.status).toBe(502);
    const next = cookies(failed);

    expect(next).toContain(".account_data=");
    appFailure = false;
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    expect((await visit(configuration, next)).status).toBe(200);
    expect((await visit(configuration, cookie)).status).toBe(401);
  });

  it.each(["invalid_grant", "missing-refresh-token"])(
    "requires login after %s",
    async (failure) => {
      if (failure === "missing-refresh-token") {
        idp.settings.issueRefreshToken = false;
        cookie = await login();
      } else idp.settings.refreshFailure = failure;
      expireIdentity();
      expect((await visit()).status).toBe(401);

      const browser = await createAuthProxy(configuration, apps).fetch(
        new Request(app, {
          headers: { cookie, accept: "text/html" },
        }),
      );

      expect(browser.status).toBe(302);
    },
  );

  it.each([
    "signature",
    "issuer",
    "audience",
    "expired",
    "missing-issued-at",
    "missing-expiry",
    "nonce",
  ])("rejects a refreshed ID token with invalid %s", async (failure) => {
    idp.settings.failure = failure;
    expireIdentity();
    expect((await visit()).status).toBe(401);
  });

  it("blocks a confirmed provider denial without discarding the session", async () => {
    idp.settings.refreshFailure = "access_denied";
    expireIdentity();
    const denied = await visit();

    expect(denied.status).toBe(403);
    expect(denied.headers.getSetCookie()).toEqual([]);
  });

  it("does not treat the original ID token as a successful refresh", async () => {
    idp.settings.omitRefreshIdToken = true;
    expireIdentity();
    expect((await visit()).status).toBe(401);
  });

  it("rejects a different subject in a valid refreshed ID token", async () => {
    idp.settings.subject = "another-person";
    expireIdentity();
    expect((await visit()).status).toBe(401);
  });

  it("binds the refresh credential to its original session", async () => {
    const second = await login();

    const account = z
      .string()
      .parse(second.split("; ").find((part) => part.includes(".account_data=")));

    const mixed = cookie
      .split("; ")
      .filter((part) => !part.includes(".account_data="))
      .concat(account)
      .join("; ");

    expireIdentity();
    expect((await visit(configuration, mixed)).status).toBe(401);
    expect(idp.refreshRequests).toHaveLength(0);
  });

  it("keeps a large group's login cookies below the common 16 KiB header limit", async () => {
    idp.settings.groups = Array.from(
      { length: 205 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    cookie = await login();
    expect(Buffer.byteLength(cookie)).toBeLessThan(16_000);
    access.groups = [z.string().parse(idp.settings.groups[0])];
    expireIdentity();
    const renewed = await visit();
    expect(renewed.status).toBe(200);
    expect(Buffer.byteLength(cookies(renewed))).toBeLessThan(16_000);
  });

  it("fetches Entra memberships directly on login and renewal", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const requested = new Request(input, init);
      const url = new URL(requested.url);

      return originalFetch(
        url.origin === "https://graph.microsoft.com"
          ? new Request(new URL(url.pathname + url.search, idp.origin), requested)
          : requested,
      );
    });
    const original = configuration;
    idp.settings.entra = true;
    idp.settings.groups = ["00000000-0000-4000-8000-000000000003"];
    idp.graphRequests.length = 0;
    configuration = {
      ...configuration,
      provider: { type: "entra", tenantId, authority: idp.origin, label: "Company" },
    };

    try {
      cookie = await login();
      access.groups = [...idp.settings.groups];
      expect(idp.graphRequests).toHaveLength(1);
      expect((await visit()).status).toBe(200);
      expect(idp.graphRequests).toHaveLength(1);
      expireIdentity();
      idp.settings.graphFailure = "throttled";
      const limited = await visit();

      expect(limited.status).toBe(503);
      expect(limited.headers.get("retry-after")).toBe("5");
      expect(cookies(limited)).toContain(".account_data=");
      expect(cookies(limited)).not.toContain(".session_data=");

      const originalCookies = new Map(
        cookie.split("; ").map((part) => [part.slice(0, part.indexOf("=")), part]),
      );

      for (const part of cookies(limited).split("; "))
        originalCookies.set(part.slice(0, part.indexOf("=")), part);
      cookie = [...originalCookies.values()].join("; ");
      vi.setSystemTime(Date.now() + 31_000);
      idp.settings.graphFailure = "";
      idp.settings.groups = [];
      expect((await visit()).status).toBe(403);
      expect(idp.graphRequests).toHaveLength(3);
    } finally {
      configuration = original;
    }
  });

  it("applies changed group restrictions immediately to an existing session", async () => {
    expect((await visit()).status).toBe(200);
    access.groups = ["reviewers"];
    access.revision++;
    expect((await visit()).status).toBe(403);
    access.groups = [];
    access.revision++;
    expect((await visit()).status).toBe(200);
  });

  it("invalidates sessions when the identity source changes but preserves client-secret rotation", async () => {
    expect((await visit({ ...configuration, clientSecret: "rotated-client-secret" })).status).toBe(
      200,
    );
    expect((await visit({ ...configuration, clientId: "other-client" })).status).toBe(401);
    expect(
      (
        await visit({
          ...configuration,
          cookieSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
            "base64url",
          ),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await visit({
          ...configuration,
          provider: { ...configuration.provider, label: "New company" },
        })
      ).status,
    ).toBe(401);
  });

  it("rejects cookie fragments combined from two valid logins", async () => {
    const second = await login();

    const token = z
      .string()
      .parse(cookie.split("; ").find((part) => part.includes(".session_token=")));

    const data = z
      .string()
      .parse(second.split("; ").find((part) => part.includes(".session_data=")));

    expect((await visit(configuration, `${token}; ${data}`)).status).toBe(401);
  });

  it("rejects configuration that would send session cookies or callbacks to the wrong host", () => {
    for (const redirectUrl of [
      "invalid",
      "http://auth.apps.example.test/oauth2/widefleet/callback",
      "https://evil.example.test/oauth2/widefleet/callback",
      "https://auth.apps.example.test/oauth2/widefleet/callback?redirect=elsewhere",
      "https://user@auth.apps.example.test/oauth2/widefleet/callback",
    ]) {
      expect(authConfiguration.safeParse({ ...configuration, redirectUrl }).success).toBe(false);
    }

    expect(authConfiguration.safeParse({ ...configuration, cookieSecret: "weak" }).success).toBe(
      false,
    );
  });
});
