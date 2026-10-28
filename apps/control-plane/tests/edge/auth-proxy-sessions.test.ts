import { authConfiguration, createAuthProxy } from "@platform/auth-proxy";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createIdentityProvider } from "./auth-proxy-idp.ts";

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
  const access = { revision: 0, groups: ["accounting"] };

  const apps = {
    resolve: (hostname: string) =>
      Promise.resolve(hostname === new URL(app).hostname ? access : null),
    fetch: () => Promise.resolve(new Response("App response")),
  };

  const login = async (settings = configuration, target = app, destinations = apps) => {
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
    cookie = await login();
  });

  afterEach(() => {
    vi.useRealTimers();
    access.groups = ["accounting"];
  });
  afterAll(async () => {
    await idp?.stop();
  });

  it("expires after one hour and does not extend the session when it is used", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 59 * 60 * 1000);
    const accepted = await visit();

    expect(accepted.status).toBe(200);
    expect(accepted.headers.getSetCookie()).toEqual([]);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect((await visit()).status).toBe(401);
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

  it("returns from company sign-in to a connector callback without an app grant", async () => {
    const target =
      "https://connector.apps.example.test/callback?code=synthetic-code&state=synthetic-state";

    const destinations = {
      resolve: async (hostname: string) =>
        hostname === "connector.apps.example.test" ? { revision: 0, groups: [] } : null,
      fetch: async () => new Response("Connector response"),
    };

    const session = await login(configuration, target, destinations);
    const proxy = createAuthProxy(configuration, { ...destinations, browser: true });
    expect((await proxy.fetch(new Request(target, { headers: { cookie: session } }))).status).toBe(
      200,
    );

    const otherSession = await login({
      ...configuration,
      organizationId: "other-org",
      redirectUrl: "https://auth.apps.example.test/oauth2/other-org/callback",
    });

    expect(
      (await proxy.fetch(new Request(target, { headers: { cookie: otherSession } }))).status,
    ).toBe(401);
  });

  it("protects every organization's sign-in cookies on connector browser routes", async () => {
    const received: Request[] = [];
    const identities: { issuer: string; subject: string; name: string }[] = [];

    const otherCookie = await login({
      ...configuration,
      organizationId: "other-org",
      redirectUrl: "https://auth.apps.example.test/oauth2/other-org/callback",
      cookieSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
    });

    const protectedCookies = [
      "__Secure-platform_sso_widefleet.session_data",
      "__Secure-platform_sso_other-org.session_token",
      "__Secure-platform_sso_other-org.session_data.0",
      "__Host-platform_sso_other-org.oauth_state",
      "platform_sso_other-org.session_token",
    ];

    const proxy = createAuthProxy(configuration, {
      ...apps,
      browser: true,
      resolve: async (hostname) =>
        hostname === "connector.apps.example.test" ? { revision: 0, groups: [] } : null,
      fetch: async (request, caller) => {
        received.push(request);
        identities.push(caller);
        const headers = new Headers();
        headers.append("set-cookie", "connector_test.state=test; Domain=apps.example.test; Path=/");

        for (const name of protectedCookies)
          headers.append("set-cookie", `${name}=forged; Domain=apps.example.test; Path=/`);

        return new Response("Connector", { headers });
      },
    });

    const path = new URL("https://connector.apps.example.test/connect");
    expect((await proxy.fetch(new Request(path))).status).toBe(401);

    const response = await proxy.fetch(
      new Request(path, {
        headers: {
          cookie: `${cookie}; ${otherCookie}; __Secure-platform_sso_other-org.session_data.0=chunk; __Host-platform_sso_other-org.oauth_state=state; platform_sso_other-org.session_token=legacy; connector_test.state=own`,
          "x-auth-request-user": "forged",
          authorization: "Bearer private",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(received[0]?.headers.get("cookie")).toBe("connector_test.state=own");
    expect(received[0]?.headers.get("authorization")).toBeNull();
    expect(identities).toEqual([
      { issuer: idp.origin, subject: "pairwise-subject", name: "Example User" },
    ]);
    expect(response.headers.getSetCookie()).toEqual(["connector_test.state=test; Path=/"]);
    access.groups = ["denied"];
    expect((await proxy.fetch(new Request(path, { headers: { cookie } }))).status).toBe(200);
    expect(received).toHaveLength(2);
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
