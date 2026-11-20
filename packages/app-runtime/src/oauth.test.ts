import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { managedOAuth, openAccessToken, type OAuthIdentity } from "./oauth.ts";
import { managedOAuthConfiguration } from "./oauth-protocol.ts";

const identity: OAuthIdentity = {
  appId: "2a600000-0000-4000-8000-000000000001",
  organizationId: "test-org",
  origin: "https://mail-team.example.test",
  caller: { issuer: "https://identity.example.test", subject: "alice" },
};

const verifier = "test-pkce-verifier-which-is-at-least-43-characters";

const gmail = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

// Google reports the email and profile permissions by their long names.
const googleAliases = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

const environment = {
  WIDEFLEET_SECRETS_KEY: "ab".repeat(32),
  WIDEFLEET_OAUTH: JSON.stringify({
    origin: "https://oauth.example.test",
    clients: {
      google: {
        provider: "google",
        clientId: "test-client",
        clientSecret: "test-secret",
        scopes: [...gmail, ...googleAliases],
        hosts: ["https://gmail.googleapis.com"],
        options: { accessType: "offline", prompt: "select_account consent" },
        issuer: "https://accounts.google.com",
        revocationUrl: "https://oauth2.googleapis.com/revoke",
      },
      github: {
        provider: "github",
        clientId: "test-github",
        clientSecret: "test-github-secret",
        scopes: ["read:user", "user:email", "repo"],
        hosts: ["https://api.github.com"],
      },
    },
  }),
};

// Token endpoint requests the provider modules send, by URL.
let requests: { url: string; body: URLSearchParams }[] = [];

let tokenResponse: (body: URLSearchParams) => Response;

beforeEach(() => {
  requests = [];
  const used = new Set<string>();
  let refreshes = 0;

  tokenResponse = (body) => {
    if (body.get("grant_type") === "authorization_code") {
      const code = body.get("code") ?? "";

      if (used.has(code)) return Response.json({ error: "invalid_grant" }, { status: 400 });
      used.add(code);
    }

    refreshes++;

    return Response.json({
      access_token: "provider-access",
      refresh_token: `provider-refresh-${refreshes}`,
      expires_in: 3600,
      scope: ["openid", ...googleAliases, gmail[3]].join(" "),
      token_type: "Bearer",
    });
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = new URLSearchParams(await request.text());
      requests.push({ url: request.url, body });

      if (request.url === "https://oauth2.googleapis.com/revoke") return new Response(null);

      return tokenResponse(body);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const authorize = async (broker = managedOAuth(environment)) => {
  const result = z.object({ url: z.url() }).parse(
    await broker.request(identity, {
      action: "authorize",
      client: "google",
      scopes: [...gmail],
      state: "local-better-auth-state",
      codeVerifier: verifier,
    }),
  );

  const url = new URL(result.url);
  const ticket = z.string().parse(url.searchParams.get("state"));

  const exchange = {
    action: "exchange",
    client: "google",
    ticket,
    code: "one-time-code",
    codeVerifier: verifier,
  } as const;

  return { broker, url, ticket, exchange };
};

const tokens = z.object({ accessToken: z.string(), refreshToken: z.string() });

describe("managed OAuth broker", () => {
  it("relays one fixed callback and returns access token placeholders and bound refresh grants", async () => {
    const { broker, url, ticket, exchange } = await authorize();

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://oauth.example.test/oauth/callback/google",
    );
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.href).not.toContain("test-secret");
    expect(url.href).not.toContain(verifier);

    const response = await broker.callback(
      new Request(
        `https://oauth.example.test/oauth/callback/google?state=${encodeURIComponent(ticket)}&code=one-time-code&iss=https://accounts.google.com`,
      ),
      async () => true,
    );

    expect(response?.status).toBe(303);
    const callback = new URL(z.string().parse(response?.headers.get("location")));
    expect(callback.origin).toBe(identity.origin);
    expect(callback.pathname).toBe("/auth/callback/google");
    expect(callback.searchParams.get("state")).toBe("local-better-auth-state");
    expect(callback.searchParams.get("managed_state")).toBe(ticket);

    const granted = tokens.parse(await broker.request(identity, exchange));

    expect(requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(requests[0]?.body.get("code_verifier")).toBe(verifier);
    expect(granted.accessToken).toMatch(/^wft1\./);
    expect(granted.accessToken).not.toContain("provider-access");
    expect(granted.refreshToken).not.toContain("provider-refresh");

    const target = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");

    expect(await openAccessToken(environment, identity.appId, granted.accessToken, target)).toBe(
      "provider-access",
    );
    expect(
      await openAccessToken(
        environment,
        identity.appId,
        granted.accessToken,
        new URL("https://api.github.com/user"),
      ),
    ).toBeNull();
    expect(
      await openAccessToken(
        environment,
        "2a600000-0000-4000-8000-000000000002",
        granted.accessToken,
        target,
      ),
    ).toBeNull();

    // Withdrawing the host or the client stops placeholders issued earlier.
    const configured = managedOAuthConfiguration.parse(JSON.parse(environment.WIDEFLEET_OAUTH));
    const { google, github } = configured.clients;

    for (const withdrawn of [
      {
        ...configured,
        clients: {
          ...configured.clients,
          google: { ...google, hosts: ["https://www.googleapis.com"] },
        },
      },
      { ...configured, clients: { github } },
    ])
      expect(
        await openAccessToken(
          { ...environment, WIDEFLEET_OAUTH: JSON.stringify(withdrawn) },
          identity.appId,
          granted.accessToken,
          target,
        ),
      ).toBeNull();

    const refreshed = tokens.parse(
      await broker.request(identity, {
        action: "refresh",
        client: "google",
        refreshToken: granted.refreshToken,
      }),
    );

    expect(refreshed.refreshToken).not.toBe(granted.refreshToken);
    await broker.request(identity, {
      action: "refresh",
      client: "google",
      refreshToken: refreshed.refreshToken,
    });
    expect(requests[2]?.body.get("refresh_token")).toBe("provider-refresh-2");
    await expect(broker.request(identity, exchange)).rejects.toThrow();
  });

  it("opens placeholders for access tokens of every accepted size", async () => {
    const { broker, exchange } = await authorize();
    const large = "a".repeat(20000);

    tokenResponse = () =>
      Response.json({
        access_token: large,
        refresh_token: "r".repeat(3000),
        scope: gmail.join(" "),
      });

    const granted = tokens.parse(await broker.request(identity, exchange));

    expect(
      await openAccessToken(
        environment,
        identity.appId,
        granted.accessToken,
        new URL("https://gmail.googleapis.com/"),
      ),
    ).toBe(large);

    const refreshed = tokens.parse(
      await broker.request(identity, {
        action: "refresh",
        client: "google",
        refreshToken: granted.refreshToken,
      }),
    );

    expect(refreshed.accessToken).toMatch(/^wft1\./);
  });

  it("rejects cross-app, cross-organization, cross-user and cross-client grants before calling providers", async () => {
    const { broker, exchange } = await authorize();
    const granted = tokens.parse(await broker.request(identity, exchange));

    requests = [];

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
          client: "google",
          refreshToken: granted.refreshToken,
        }),
      ).rejects.toThrow("another app");
    }

    await expect(broker.request(identity, { ...exchange, client: "github" })).rejects.toThrow(
      "another app",
    );
    await expect(
      broker.request(identity, {
        action: "refresh",
        client: "google",
        refreshToken: exchange.ticket,
      }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("rejects tampering, wrong PKCE, expiration and an unavailable app without exchanging", async () => {
    const { broker, exchange, ticket } = await authorize();

    await expect(
      broker.request(identity, { ...exchange, codeVerifier: "x".repeat(43) }),
    ).rejects.toThrow("PKCE");

    const callback = (state = ticket) =>
      new Request(
        `https://oauth.example.test/oauth/callback/google?state=${encodeURIComponent(state)}&code=code`,
      );

    expect((await broker.callback(callback(), async () => false))?.status).toBe(400);
    // The encrypted ticket may already start with X; always change the IV bytes.
    const tampered = `${ticket.startsWith("X") ? "Y" : "X"}${ticket.slice(1)}`;

    expect((await broker.callback(callback(tampered), async () => true))?.status).toBe(400);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 601000);
    await expect(broker.request(identity, exchange)).rejects.toThrow("expired");
    expect((await broker.callback(callback(), async () => true))?.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("allows only the scopes the operator configured", async () => {
    const broker = managedOAuth(environment);

    await expect(
      broker.request(identity, {
        action: "authorize",
        client: "google",
        scopes: ["https://www.googleapis.com/auth/gmail.send"],
        state: "state",
        codeVerifier: verifier,
      }),
    ).rejects.toThrow("not allowed");

    const { exchange } = await authorize(broker);

    tokenResponse = () =>
      Response.json({
        access_token: "wider-access",
        refresh_token: "wider-refresh",
        scope: [...gmail, "https://mail.google.com/"].join(" "),
      });

    await expect(broker.request(identity, exchange)).rejects.toThrow("does not allow");
    expect(requests.at(-1)?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(requests.at(-1)?.body.get("token")).toBe("wider-refresh");
  });

  it("revokes grants at the provider when its client declares a revocation endpoint", async () => {
    const { broker, exchange } = await authorize();
    const granted = tokens.parse(await broker.request(identity, exchange));

    expect(
      await broker.request(identity, {
        action: "revoke",
        client: "google",
        token: granted.refreshToken,
      }),
    ).toEqual({ revoked: true });
    expect(requests.at(-1)?.body.get("token")).toBe("provider-refresh-1");
    expect(
      await broker.request(identity, {
        action: "revoke",
        client: "google",
        token: granted.accessToken,
      }),
    ).toEqual({ revoked: true });
    expect(requests.at(-1)?.body.get("token")).toBe("provider-access");
    await expect(
      broker.request(
        { ...identity, caller: { ...identity.caller, subject: "bob" } },
        { action: "revoke", client: "google", token: granted.refreshToken },
      ),
    ).rejects.toThrow("another app");
  });

  it("keeps unconfigured runtimes disabled and rejects credentials selected by a caller", async () => {
    const disabled = managedOAuth({ WIDEFLEET_SECRETS_KEY: environment.WIDEFLEET_SECRETS_KEY });

    expect(
      await disabled.request(identity, { action: "configuration", client: "google" }),
    ).toBeNull();
    const broker = managedOAuth(environment);

    expect(await broker.request(identity, { action: "configuration", client: "google" })).toEqual({
      clientId: "test-client",
      scopes: [...gmail, ...googleAliases],
    });
    expect(await broker.request(identity, { action: "configuration", client: "slack" })).toBeNull();

    const input = { action: "configuration", client: "google", clientSecret: "attacker" } as const;

    await expect(broker.request(identity, input)).rejects.toThrow();
    expect(
      await broker.callback(
        new Request("https://wrong.example.test/oauth/callback/google"),
        async () => true,
      ),
    ).toBeNull();
  });

  it("validates callback clients and issuers and returns cancellations to the original app", async () => {
    const { broker, ticket } = await authorize();
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

  it.each([
    "{invalid-json-secret",
    // The earlier format with fixed providers.
    JSON.stringify({
      origin: "https://oauth.example.test",
      providers: { google: { clientId: "id", clientSecret: "secret" } },
    }),
  ])("keeps invalid managed configuration out of normal app routing", async (value) => {
    const available = vi.fn(async () => true);
    const broker = managedOAuth({ ...environment, WIDEFLEET_OAUTH: value });

    for (const path of ["/", "/api/data", "/oauth/callback/google"])
      expect(await broker.callback(new Request(`${identity.origin}${path}`), available)).toBeNull();
    expect(available).not.toHaveBeenCalled();
    await expect(
      broker.request(identity, { action: "configuration", client: "google" }),
    ).rejects.toThrow(/^Managed OAuth configuration is invalid$/);
    expect(requests).toHaveLength(0);
  });

  it.each([
    () => Response.json({ error: "invalid_grant", error_description: "provider-secret-response" }),
    () =>
      Response.json(
        { error: "invalid_grant", error_description: "provider-secret-response" },
        { status: 400 },
      ),
    () =>
      Response.json(
        { error: "invalid_client", detail: "provider-secret-response" },
        { status: 401 },
      ),
    () => new Response("provider-secret-response"),
    () => new Response("provider-secret-response", { status: 500 }),
  ])("does not expose or log provider error responses (%#)", async (failure) => {
    const { broker, exchange } = await authorize();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    tokenResponse = failure;

    await expect(broker.request(identity, exchange)).rejects.not.toThrow(
      "provider-secret-response",
    );
    expect(JSON.stringify([logged.mock.calls, warned.mock.calls])).not.toContain(
      "provider-secret-response",
    );
    logged.mockRestore();
    warned.mockRestore();
  });
});
