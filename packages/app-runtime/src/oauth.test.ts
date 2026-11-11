import { createHash } from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
import { z } from "zod";
import { managedOAuth, type OAuthIdentity } from "./oauth.ts";

const identity: OAuthIdentity = {
  appId: "2a600000-0000-4000-8000-000000000001",
  organizationId: "test-org",
  origin: "https://mail-team.example.test",
  caller: { issuer: "https://identity.example.test", subject: "alice" },
};

const verifier = "test-pkce-verifier-which-is-at-least-43-characters";

const codeChallenge = createHash("sha256").update(verifier).digest("base64url");

const environment = {
  WIDEFLEET_SECRETS_KEY: "ab".repeat(32),
  WIDEFLEET_OAUTH: JSON.stringify({
    origin: "https://oauth.example.test",
    providers: {
      google: { clientId: "test-client", clientSecret: "test-secret" },
      github: { clientId: "test-github", clientSecret: "test-github-secret" },
      microsoft: { clientId: "test-microsoft", clientSecret: "test-microsoft-secret" },
    },
  }),
};

const setup = async () => {
  const requests: URLSearchParams[] = [];
  const used = new Set<string>();

  const broker = managedOAuth(environment, async (url, init) => {
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(await new Request(url, init).text());
    requests.push(body);
    expect(body.get("client_secret")).toBe("test-secret");

    if (body.get("grant_type") === "authorization_code") {
      const code = body.get("code") ?? "";

      if (used.has(code)) return Response.json({ error: "invalid_grant" }, { status: 400 });
      used.add(code);
      expect(body.get("redirect_uri")).toBe("https://oauth.example.test/oauth/callback/google");
    } else expect(body.get("refresh_token")).toMatch(/^provider-refresh/);

    return Response.json({
      access_token: "provider-access",
      refresh_token: `provider-refresh-${requests.length}`,
      expires_in: 3600,
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
    });
  });

  const result = z.object({ url: z.url() }).parse(
    await broker.request(identity, {
      action: "authorize",
      provider: "google",
      state: "local-better-auth-state",
      codeChallenge,
    }),
  );

  const url = new URL(result.url);
  const ticket = z.string().parse(url.searchParams.get("state"));

  const exchange = {
    action: "exchange",
    provider: "google",
    ticket,
    code: "one-time-code",
    codeVerifier: verifier,
  } as const;

  return { broker, requests, url, ticket, exchange };
};

describe("managed OAuth relay", () => {
  afterEach(() => vi.useRealTimers());

  it("uses one fixed callback, returns tokens to the app and binds rotating refresh grants", async () => {
    const { broker, url, ticket, exchange, requests } = await setup();
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://oauth.example.test/oauth/callback/google",
    );
    expect(url.searchParams.get("code_challenge")).toBe(codeChallenge);
    expect(url.href).not.toContain("test-secret");

    const response = await broker.callback(
      new Request(
        `https://oauth.example.test/oauth/callback/google?state=${encodeURIComponent(ticket)}&code=one-time-code`,
      ),
      async () => true,
    );

    expect(response?.status).toBe(303);
    const callback = new URL(z.string().parse(response?.headers.get("location")));
    expect(callback.origin).toBe(identity.origin);
    expect(callback.searchParams.get("state")).toBe("local-better-auth-state");
    expect(callback.searchParams.get("managed_state")).toBe(ticket);

    const tokens = z
      .object({ accessToken: z.string(), refreshToken: z.string() })
      .parse(await broker.request(identity, exchange));

    expect(tokens.accessToken).toBe("provider-access");
    expect(tokens.refreshToken).not.toContain("provider-refresh");

    const refreshed = z.object({ refreshToken: z.string() }).parse(
      await broker.request(identity, {
        action: "refresh",
        provider: "google",
        refreshToken: tokens.refreshToken,
      }),
    );

    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
    await broker.request(identity, {
      action: "refresh",
      provider: "google",
      refreshToken: refreshed.refreshToken,
    });
    expect(requests[2]?.get("refresh_token")).toBe("provider-refresh-2");
    await expect(broker.request(identity, exchange)).rejects.toThrow("token request failed");
  });

  it("rejects cross-app, cross-organization, cross-user and cross-provider exchanges and refreshes before calling providers", async () => {
    const { broker, requests, exchange } = await setup();

    const tokens = z
      .object({ refreshToken: z.string() })
      .parse(await broker.request(identity, exchange));

    const others = [
      { ...identity, appId: "2a600000-0000-4000-8000-000000000002" },
      { ...identity, organizationId: "other-org" },
      { ...identity, origin: "https://other.example.test" },
      { ...identity, caller: { ...identity.caller, subject: "bob" } },
      { ...identity, caller: { ...identity.caller, issuer: "https://other-id.example.test" } },
    ];

    for (const other of others) {
      await expect(broker.request(other, exchange)).rejects.toThrow("another app");
      await expect(
        broker.request(other, {
          action: "refresh",
          provider: "google",
          refreshToken: tokens.refreshToken,
        }),
      ).rejects.toThrow("another app");
    }

    await expect(broker.request(identity, { ...exchange, provider: "github" })).rejects.toThrow(
      "another app",
    );
    await expect(
      broker.request(identity, {
        action: "refresh",
        provider: "google",
        refreshToken: exchange.ticket,
      }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("rejects tampering, wrong PKCE, expiration and an unavailable app without redirecting or exchanging", async () => {
    const { broker, requests, exchange, ticket } = await setup();
    await expect(
      broker.request(identity, { ...exchange, codeVerifier: "x".repeat(43) }),
    ).rejects.toThrow("PKCE");

    const callback = (state = ticket) =>
      new Request(
        `https://oauth.example.test/oauth/callback/google?state=${encodeURIComponent(state)}&code=code`,
      );

    expect((await broker.callback(callback(), async () => false))?.status).toBe(400);
    expect((await broker.callback(callback(`X${ticket.slice(1)}`), async () => true))?.status).toBe(
      400,
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 601000);
    await expect(broker.request(identity, exchange)).rejects.toThrow("expired");
    expect((await broker.callback(callback(), async () => true))?.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("keeps unconfigured runtimes disabled and rejects credentials selected by a caller", async () => {
    const disabled = managedOAuth({ WIDEFLEET_SECRETS_KEY: environment.WIDEFLEET_SECRETS_KEY });
    expect(
      await disabled.request(identity, { action: "configuration", provider: "google" }),
    ).toBeNull();
    const { broker } = await setup();
    expect(await broker.request(identity, { action: "configuration", provider: "google" })).toEqual(
      { clientId: "test-client" },
    );

    const input = {
      action: "configuration",
      provider: "google",
      clientSecret: "attacker",
    } as const;

    await expect(broker.request(identity, input)).rejects.toThrow();
    expect(
      await broker.callback(
        new Request("https://wrong.example.test/oauth/callback/google"),
        async () => true,
      ),
    ).toBeNull();
  });

  it("validates callback providers and issuers and returns cancellations to the original app", async () => {
    const { broker, ticket } = await setup();
    const callback = new URL("https://oauth.example.test/oauth/callback/google");
    callback.searchParams.set("state", ticket);
    callback.searchParams.set("error", "access_denied");
    const cancelled = await broker.callback(new Request(callback), async () => true);
    const destination = new URL(z.string().parse(cancelled?.headers.get("location")));
    expect(destination.searchParams.get("error")).toBe("access_denied");
    expect(destination.searchParams.has("code")).toBe(false);
    callback.searchParams.set("iss", "https://attacker.example.test");
    expect((await broker.callback(new Request(callback), async () => true))?.status).toBe(400);
    callback.searchParams.delete("iss");
    callback.pathname = "/oauth/callback/github";
    expect((await broker.callback(new Request(callback), async () => true))?.status).toBe(400);
  });

  it("does not follow token endpoint redirects or expose malformed provider responses", async () => {
    const { exchange } = await setup();

    for (const response of [
      new Response(null, { status: 302, headers: { location: "https://attacker.example.test" } }),
      new Response("provider-secret-response"),
      Response.json({ error: "invalid_grant", error_description: "provider-secret-response" }),
    ]) {
      const broker = managedOAuth(environment, async (_url, init) => {
        expect(init?.redirect).toBe("manual");

        return response;
      });

      await expect(broker.request(identity, exchange)).rejects.toThrow(
        /^OAuth provider (token request failed|returned no usable token)$/,
      );
    }
  });
});
