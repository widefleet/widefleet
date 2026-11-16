import { authConfiguration, createAuthProxy } from "@platform/auth-proxy";
import { googleGroupsScope } from "@platform/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createIdentityProvider } from "./auth-proxy-idp.ts";

const app = "https://ledger.apps.example.test/";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .flatMap((value) => (value.includes("Max-Age=0") ? [] : [value.split(";")[0]]))
    .join("; ");

describe("Google Workspace app identity", () => {
  let idp: Awaited<ReturnType<typeof createIdentityProvider>>;
  let configuration: z.infer<typeof authConfiguration>;
  const calls: URL[] = [];
  let memberships = ["accounting@example.test", "auditors@example.test"];
  let directoryStatus = 200;
  let workspaceDomain = "example.test";
  let allowedGroups = ["accounting@example.test"];
  let repeatPage = false;
  let invalidGroup = false;

  const apps = {
    resolve: (hostname: string) =>
      Promise.resolve(
        hostname === new URL(app).hostname ? { revision: 0, groups: allowedGroups } : null,
      ),
    fetch: (request: Request) =>
      Promise.resolve(Response.json(Object.fromEntries(request.headers))),
  };

  beforeAll(async () => {
    idp = await createIdentityProvider();
    configuration = authConfiguration.parse({
      organizationId: "widefleet",
      provider: { type: "google", domain: "example.test" },
      clientId: "app-login",
      clientSecret: "synthetic-client-secret",
      cookieSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
      domain: "apps.example.test",
      redirectUrl: "https://auth.apps.example.test/oauth2/widefleet/callback",
      scopes: ["openid", "profile", "email", googleGroupsScope],
    });
  });

  beforeEach(() => {
    idp.settings.google = true;
    idp.settings.workspaceDomain = "example.test";
    idp.settings.failure = "";
    idp.settings.grantedScopes = `openid profile email ${googleGroupsScope}`;
    idp.settings.omitRefreshScopes = false;
    configuration.scopes = ["openid", "profile", "email", googleGroupsScope];
    allowedGroups = ["accounting@example.test"];
    repeatPage = false;
    invalidGroup = false;
    calls.length = 0;
    memberships = ["accounting@example.test", "auditors@example.test"];
    directoryStatus = 200;
    workspaceDomain = "example.test";
    const originalFetch = globalThis.fetch;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.origin === "https://accounts.google.com")
        return originalFetch(new Request(new URL(url.pathname, idp.origin), request));

      if (url.origin === "https://cloudidentity.googleapis.com") {
        calls.push(url);
        expect(url.pathname).toBe("/v1/groups/-/memberships:searchDirectGroups");
        expect(request.headers.get("authorization")).toBe("Bearer fixture-access-token");
        expect(request.redirect).toBe("error");

        if (directoryStatus !== 200)
          return new Response(null, { status: directoryStatus, headers: { "retry-after": "7" } });
        const offset = Number(url.searchParams.get("pageToken") || "0");

        return Response.json({
          memberships: memberships.slice(offset, offset + 1).map((id) => ({
            groupKey: { id: invalidGroup ? "invalid-group" : id },
          })),
          nextPageToken: repeatPage
            ? "1"
            : offset + 1 < memberships.length
              ? String(offset + 1)
              : undefined,
        });
      }

      return originalFetch(request);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await idp.stop();
  });

  const login = async () => {
    idp.settings.workspaceDomain = workspaceDomain;
    const proxy = createAuthProxy(configuration, apps);

    const started = await proxy.fetch(
      new Request(
        `https://auth.apps.example.test/oauth2/widefleet/start?rd=${encodeURIComponent(app)}`,
      ),
    );

    const location = new URL(z.string().parse(started.headers.get("location")));

    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("hd")).toBe("example.test");
    expect(location.searchParams.get("scope")).not.toContain("offline_access");
    expect(location.searchParams.get("scope")?.includes(googleGroupsScope)).toBe(
      configuration.scopes?.includes(googleGroupsScope) ?? false,
    );
    const authorized = await fetch(location, { redirect: "manual" });

    return proxy.fetch(
      new Request(z.string().parse(authorized.headers.get("location")), {
        headers: { cookie: cookies(started) },
      }),
    );
  };

  const visit = (cookie: string) =>
    createAuthProxy(configuration, apps).fetch(
      new Request(app, { headers: { cookie, accept: "text/html" } }),
    );

  const expire = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
  };

  it("loads all membership pages and rechecks groups when the provider token expires", async () => {
    const signedIn = await login();

    expect(signedIn.headers.get("location")).toBe(app);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.get("query")).toBe(
      `member_key_id == "user@example.test" && 'cloudidentity.googleapis.com/groups.discussion_forum' in labels`,
    );
    const cookie = cookies(signedIn);
    const allowed = await visit(cookie);

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      "x-auth-request-groups": "accounting@example.test,auditors@example.test",
    });
    expect(calls).toHaveLength(2);
    memberships = ["auditors@example.test"];
    expire();
    const denied = await visit(cookie);

    expect(denied.status).toBe(403);
    expect(denied.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(calls).toHaveLength(3);
  });

  it.each(["other-company.test", ""])(
    "rejects the Workspace domain %s before directory access",
    async (domain) => {
      workspaceDomain = domain;
      expect((await login()).headers.get("location")).not.toBe(app);
      expect(calls).toHaveLength(0);
    },
  );

  it("retains cookies through directory throttling and recovers on the next request", async () => {
    const cookie = cookies(await login());
    expire();
    directoryStatus = 429;
    const unavailable = await visit(cookie);

    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("7");
    expect(cookies(unavailable)).toContain(".account_data=");
    expect(cookies(unavailable)).not.toContain(".session_data=");
    directoryStatus = 200;
    expect((await visit(cookie)).status).toBe(200);
  });

  it("supports sign-in without group scope and keeps restricted apps denied", async () => {
    configuration.scopes = ["openid", "profile", "email"];
    const cookie = cookies(await login());
    expect((await visit(cookie)).status).toBe(403);
    allowedGroups = [];
    expect((await visit(cookie)).status).toBe(200);
    expire();
    expect((await visit(cookie)).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("continues sign-in if the user withholds group consent, including after refresh", async () => {
    idp.settings.grantedScopes = "openid profile email";
    const cookie = cookies(await login());
    expect((await visit(cookie)).status).toBe(403);
    allowedGroups = [];
    expect((await visit(cookie)).status).toBe(200);
    idp.settings.omitRefreshScopes = true;
    expire();
    expect((await visit(cookie)).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("inherits the original group grant when refresh omits scopes", async () => {
    const cookie = cookies(await login());
    idp.settings.omitRefreshScopes = true;
    memberships = [];
    expire();
    expect((await visit(cookie)).status).toBe(403);
    expect(calls).toHaveLength(3);
  });

  it("drops groups when the provider reduces the grant on refresh", async () => {
    const cookie = cookies(await login());
    idp.settings.grantedScopes = "openid profile email";
    expire();
    expect((await visit(cookie)).status).toBe(403);
    expect(calls).toHaveLength(2);
  });

  it("requires fresh sign-in when the administrator removes the group scope", async () => {
    const cookie = cookies(await login());
    configuration.scopes = ["openid", "profile", "email"];
    expect((await visit(cookie)).status).toBe(302);
    expect(calls).toHaveLength(2);
  });

  it("rejects unverified email before group access", async () => {
    idp.settings.failure = "email";
    expect((await login()).headers.get("location")).not.toBe(app);
    expect(calls).toHaveLength(0);
  });

  it.each([403, 500, 302])("does not reuse stale groups on lookup status %s", async (status) => {
    const cookie = cookies(await login());
    directoryStatus = status;
    expire();
    expect((await visit(cookie)).status).toBe(503);
  });

  it.each(["pagination", "group"])(
    "rejects invalid %s instead of partial membership",
    async (failure) => {
      const cookie = cookies(await login());
      repeatPage = failure === "pagination";
      invalidGroup = failure === "group";
      expire();
      expect((await visit(cookie)).status).toBe(503);
    },
  );
});
