import { authConfiguration, createAuthProxy, type AppUserActivity } from "@platform/auth-proxy";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createIdentityProvider, pictureBytes, tenantId } from "./auth-proxy-idp.ts";
import { memoryPictures } from "../memory-pictures.fixture.ts";

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
    pictures: memoryPictures(),
    resolve: (hostname: string) =>
      Promise.resolve(hostname === new URL(app).hostname ? access : null),
    fetch: (request: Request) =>
      appFailure
        ? Promise.reject(new Error("Fixture app unavailable"))
        : Promise.resolve(Response.json(Object.fromEntries(request.headers))),
  };

  const login = async (
    settings = configuration,
    target = app,
    destinations: Parameters<typeof createAuthProxy>[1] = apps,
  ) => {
    const proxy = createAuthProxy(settings, destinations);

    const started = await proxy.fetch(
      new Request(
        `https://auth.apps.example.test/oauth2/${settings.organizationId}/start?rd=${encodeURIComponent(target)}`,
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

    expect(completed.headers.get("location")).toBe(target);

    return cookies(completed);
  };

  const visit = (settings = configuration, session = cookie) =>
    createAuthProxy(settings, apps).fetch(new Request(app, { headers: { cookie: session } }));

  beforeAll(async () => {
    idp = await createIdentityProvider([
      "https://auth.apps.example.test/oauth2/widefleet/callback",
      "https://auth.apps.example.test/oauth2/other-org/callback",
    ]);
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
    idp.settings.name = "Example User";
    idp.settings.groups = ["accounting"];
    idp.settings.graphFailure = "";
    idp.settings.keysAvailable = true;
    idp.settings.refreshReplaySeconds = 30;
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

  it.each([false, true])(
    "isolates app cookies and forwards the current caller after renewal: %s",
    async (renew) => {
      if (renew) {
        expireIdentity();
        idp.settings.name = "Renewed User";
      }

      const forwarded = vi.fn(async () => {
        const headers = new Headers();
        headers.append(
          "set-cookie",
          "app_session=oauth; Domain=apps.example.test; Path=/; Secure; HttpOnly; SameSite=Lax",
        );
        headers.append("set-cookie", "__Host-app_state=state; Path=/; Secure; HttpOnly");

        for (const name of [
          "platform_sso_other.session_data",
          "__Secure-platform_sso_other.session_token",
          "__Host-platform_sso_other.oauth_state",
        ])
          headers.append("set-cookie", `${name}=forged; Domain=apps.example.test; Path=/`);

        return new Response("Connected", { headers });
      });

      const calls: { request: Request; caller: unknown }[] = [];

      const proxy = createAuthProxy(configuration, {
        ...apps,
        fetch: (request, caller) => {
          calls.push({ request, caller });

          return forwarded();
        },
      });

      const response = await proxy.fetch(
        new Request(app, {
          headers: {
            cookie: `${cookie}; app_session=oauth; __Secure-platform_sso_other.session_token=private; platform_sso_other.session_data=private`,
            "x-auth-request-user": "forged",
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(calls[0]?.caller).toEqual({
        issuer: idp.origin,
        subject: "pairwise-subject",
        name: renew ? "Renewed User" : "Example User",
      });
      expect(calls[0]?.request.headers.get("cookie")?.trim()).toBe("app_session=oauth");
      expect(calls[0]?.request.headers.get("x-auth-request-user")).toBe("pairwise-subject");

      const sessionCookies = response.headers
        .getSetCookie()
        .filter((value) => value.startsWith("__Secure-platform_sso_widefleet."));

      expect(sessionCookies.length > 0).toBe(renew);
      expect(
        response.headers.getSetCookie().filter((value) => !sessionCookies.includes(value)),
      ).toEqual([
        "app_session=oauth; Path=/; Secure; HttpOnly; SameSite=Lax",
        "__Host-app_state=state; Path=/; Secure; HttpOnly",
      ]);
    },
  );

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

  it("reports sign-in and renewal as app user activity, not every request", async () => {
    const reported: AppUserActivity[] = [];
    const observed = { ...apps, observe: (activity: AppUserActivity) => reported.push(activity) };
    const session = await login(configuration, app, observed);
    const proxy = createAuthProxy(configuration, observed);

    const person = {
      issuer: idp.origin,
      identity: { id: "pairwise-subject", name: "Example User" },
    };

    expect(reported).toMatchObject([{ trigger: "sign_in", ...person }]);
    expect(reported[0]?.hostname).toBeUndefined();
    expect((await proxy.fetch(new Request(app, { headers: { cookie: session } }))).status).toBe(
      200,
    );
    expect(reported).toHaveLength(1);
    expireIdentity();
    expect((await proxy.fetch(new Request(app, { headers: { cookie: session } }))).status).toBe(
      200,
    );
    expect(reported).toMatchObject([
      { trigger: "sign_in", ...person },
      { trigger: "renewal", hostname: new URL(app).hostname, ...person },
    ]);
  });

  it("keeps sign-in working when observation fails", async () => {
    const session = await login(configuration, app, {
      ...apps,
      observe: () => {
        throw new Error("Analytics unavailable");
      },
    });

    expect((await visit(configuration, session)).status).toBe(200);
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

  it("preserves the login when the provider's signing keys are unavailable", async () => {
    idp.settings.rotateRefreshTokens = true;
    idp.settings.refreshReplaySeconds = 0;
    expireIdentity();
    idp.settings.keysAvailable = false;
    const unavailable = await visit();

    expect(unavailable.status).toBe(503);
    expect(cookies(unavailable)).toContain(".account_data=");
    expect(cookies(unavailable)).not.toContain(".session_data=");
    idp.settings.keysAvailable = true;

    // The browser keeps its session and stores the rotated provider credential.
    const rotated = [
      ...new Map(
        `${cookie}; ${cookies(unavailable)}`
          .split("; ")
          .map((pair) => [pair.split("=")[0], pair] as const),
      ).values(),
    ].join("; ");

    expect((await visit(configuration, rotated)).status).toBe(200);
    expect((await visit(configuration, cookie)).status).toBe(401);
  });

  it("delivers rotated credentials even when the app throws", async () => {
    appFailure = true;
    await expect(visit()).rejects.toThrow("Fixture app unavailable");
    expireIdentity();
    const failed = await visit();

    expect(failed.status).toBe(502);
    const next = cookies(failed);

    expect(next).toContain(".account_data=");
    appFailure = false;
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    expect((await visit(configuration, next)).status).toBe(200);
    expect((await visit(configuration, cookie)).status).toBe(401);
  });

  it("keeps the login while the provider rejects the client credentials", async () => {
    idp.settings.refreshFailure = "invalid_client";
    expireIdentity();
    expect((await visit()).status).toBe(503);
    idp.settings.refreshFailure = "";
    expect((await visit()).status).toBe(200);
  });

  it.each(["invalid_grant", "invalid_request", "missing-refresh-token"])(
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

  it.each(["oidc", "entra"] as const)(
    "copies the %s sign-in's picture and shows it on the app's origin",
    async (provider) => {
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
      const destinations = { ...apps, pictures: memoryPictures() };
      idp.settings.picture = true;

      if (provider === "entra") {
        idp.settings.entra = true;
        idp.settings.groups = ["00000000-0000-4000-8000-000000000003"];
        access.groups = [...idp.settings.groups];
        configuration = {
          ...configuration,
          provider: { type: "entra", tenantId, authority: idp.origin, label: "Company" },
        };
      }

      try {
        const session = await login(configuration, app, destinations);
        const proxy = createAuthProxy(configuration, destinations);
        const forwarded = await proxy.fetch(new Request(app, { headers: { cookie: session } }));

        const path = z
          .string()
          .regex(/^\/oauth2\/pictures\/[^/?]+\?v=[0-9a-f]{16}$/)
          .parse(
            z.record(z.string(), z.string()).parse(await forwarded.json())[
              "x-auth-request-picture"
            ],
          );

        const picture = await proxy.fetch(
          new Request(new URL(path, app), { headers: { cookie: session } }),
        );

        expect(picture.status).toBe(200);
        expect(picture.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(await picture.arrayBuffer())).toEqual(pictureBytes);

        const unchanged = await proxy.fetch(
          new Request(new URL(path, app), {
            headers: {
              cookie: session,
              "if-none-match": z.string().parse(picture.headers.get("etag")),
            },
          }),
        );

        expect(unchanged.status).toBe(304);
        // Only people signed in to the organization's apps see its pictures.
        expect((await proxy.fetch(new Request(new URL(path, app)))).status).toBe(401);
      } finally {
        idp.settings.picture = false;
        configuration = original;
      }
    },
  );

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
      const logged = vi.spyOn(console, "error").mockReturnValue(undefined);
      const limited = await visit();

      expect(logged).toHaveBeenCalledWith(
        "Company authorization renewal failed",
        expect.objectContaining({ stage: "identity", type: "APIError" }),
      );
      logged.mockRestore();
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
