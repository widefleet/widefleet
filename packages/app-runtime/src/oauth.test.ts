import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { managedOAuth, openAccessToken, type OAuthIdentity } from "./oauth.ts";
import { managedOAuthConfiguration } from "./oauth-protocol.ts";
import { testKeyring } from "../fixtures/keyring.ts";

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

// Google reports the email and profile permissions by their long names, which
// the client's scopes do not list. Every token response below grants them.
const googleAliases = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

const environment = {
  WIDEFLEET_SECRETS_KEYS: testKeyring(),
  WIDEFLEET_OAUTH: JSON.stringify({
    origin: "https://oauth.example.test",
    clients: {
      google: {
        provider: "google",
        clientId: "test-client",
        clientSecret: "test-secret",
        scopes: [...gmail],
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
      // A service without scopes that takes its client's credentials with HTTP
      // Basic authentication when revoking.
      notion: {
        provider: "notion",
        clientId: "test-notion",
        clientSecret: "test-notion-secret",
        scopes: [],
        hosts: ["https://api.notion.com"],
        revocationUrl: "https://api.notion.com/v1/oauth/revoke",
        revocationEndpointAuthMethod: "client_secret_basic",
      },
    },
  }),
};

// Token endpoint requests the provider modules send, by URL.
let requests: { url: string; body: URLSearchParams; authorization: string | null }[] = [];

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
      requests.push({
        url: request.url,
        body,
        authorization: request.headers.get("authorization"),
      });

      if (request.url === "https://oauth2.googleapis.com/revoke") return new Response(null);

      // Notion revokes only with the client's credentials in HTTP Basic.
      if (request.url === "https://api.notion.com/v1/oauth/revoke")
        return request.headers.get("authorization") ===
          `Basic ${btoa("test-notion:test-notion-secret")}` && !body.has("client_secret")
          ? Response.json({ request_id: "request-1" })
          : Response.json({ error: "invalid_client" }, { status: 401 });

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

    const response = await broker.handle(
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
    // The largest values still fit the limits of the requests that carry them.
    expect(granted.accessToken.length).toBeLessThanOrEqual(30000);
    expect(granted.refreshToken.length).toBeLessThanOrEqual(12000);
  });

  it("retires access placeholders and refresh grants once another key version is active", async () => {
    const { broker, exchange } = await authorize();
    const granted = tokens.parse(await broker.request(identity, exchange));

    const rotated = {
      ...environment,
      WIDEFLEET_SECRETS_KEYS: testKeyring(["next", 0xcd], ["test", 0xab]),
    };

    await expect(
      managedOAuth(rotated).request(identity, {
        action: "refresh",
        client: "google",
        refreshToken: granted.refreshToken,
      }),
    ).rejects.toThrow();
    expect(
      await openAccessToken(
        rotated,
        identity.appId,
        granted.accessToken,
        new URL("https://gmail.googleapis.com/"),
      ),
    ).toBeNull();
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

    expect((await broker.handle(callback(), async () => false))?.status).toBe(400);
    // The encrypted ticket may already start with X; always change the IV bytes.
    const tampered = `${ticket.startsWith("X") ? "Y" : "X"}${ticket.slice(1)}`;

    expect((await broker.handle(callback(tampered), async () => true))?.status).toBe(400);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 601000);
    await expect(broker.request(identity, exchange)).rejects.toThrow("expired");
    expect((await broker.handle(callback(), async () => true))?.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("requests only the scopes the operator configured", async () => {
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

    // Without scopes, the server could grant its own defaults.
    await expect(
      broker.request(identity, {
        action: "authorize",
        client: "google",
        scopes: [],
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

    // Earlier consent for the same client can widen the grant; only the user or
    // an administrator can withdraw it, so the token is still issued.
    const granted = z
      .object({ scopes: z.array(z.string()) })
      .parse(await broker.request(identity, exchange));

    expect(granted.scopes).toContain("https://mail.google.com/");
    expect(requests.map((request) => request.url)).not.toContain(
      "https://oauth2.googleapis.com/revoke",
    );
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
    // Without a method, the credentials go in the form.
    expect(requests.at(-1)?.body.get("client_secret")).toBe("test-secret");
    expect(requests.at(-1)?.authorization).toBeNull();
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

  it("authorizes a client without scopes, refreshes and revokes with HTTP Basic authentication", async () => {
    const broker = managedOAuth(environment);

    const authorizeNotion = (scopes: string[]) =>
      broker.request(identity, {
        action: "authorize",
        client: "notion",
        scopes,
        state: "local-better-auth-state",
        codeVerifier: verifier,
      });

    await expect(authorizeNotion(["read"])).rejects.toThrow("not allowed");
    const url = new URL(z.object({ url: z.url() }).parse(await authorizeNotion([])).url);
    expect(url.searchParams.has("scope")).toBe(false);

    const granted = tokens.parse(
      await broker.request(identity, {
        action: "exchange",
        client: "notion",
        ticket: z.string().parse(url.searchParams.get("state")),
        code: "one-time-code",
        codeVerifier: verifier,
      }),
    );

    // Notion authenticates the client with HTTP Basic for codes and refreshes alike.
    const basic = `Basic ${btoa("test-notion:test-notion-secret")}`;
    expect(requests.at(-1)).toMatchObject({ url: "https://api.notion.com/v1/oauth/token" });
    expect(requests.at(-1)?.authorization).toBe(basic);
    expect(requests.at(-1)?.body.has("client_secret")).toBe(false);
    tokens.parse(
      await broker.request(identity, {
        action: "refresh",
        client: "notion",
        refreshToken: granted.refreshToken,
      }),
    );
    expect(requests.at(-1)?.body.get("grant_type")).toBe("refresh_token");
    expect(requests.at(-1)?.authorization).toBe(basic);
    expect(requests.at(-1)?.body.has("client_secret")).toBe(false);

    expect(
      await broker.request(identity, {
        action: "revoke",
        client: "notion",
        token: granted.refreshToken,
      }),
    ).toEqual({ revoked: true });

    // The credentials go in the Authorization header, never in the form.
    expect(requests.at(-1)).toEqual({
      url: "https://api.notion.com/v1/oauth/revoke",
      body: new URLSearchParams({ token: "provider-refresh-1" }),
      authorization: basic,
    });
  });

  it("keeps scopes required except for registered clients and revocation methods to registered clients with a revocation URL", () => {
    const valid = (client: Record<string, string | string[]>) =>
      managedOAuthConfiguration.safeParse({
        origin: "https://oauth.example.test",
        clients: { example: client },
      }).success;

    const registered = {
      provider: "notion",
      clientId: "id",
      clientSecret: "secret",
      scopes: [],
      hosts: ["https://api.notion.com"],
    };

    const metadataDocument = {
      registration: "client-id-metadata-document",
      authorizationUrl: "https://auth.example.test/authorize",
      tokenUrl: "https://auth.example.test/token",
      scopes: ["read"],
      hosts: ["https://api.example.test"],
      revocationUrl: "https://auth.example.test/revoke",
    };

    expect(valid(registered)).toBe(true);
    expect(valid({ ...registered, revocationEndpointAuthMethod: "client_secret_basic" })).toBe(
      false,
    );
    expect(
      valid({
        ...registered,
        revocationUrl: "https://api.notion.com/v1/oauth/revoke",
        revocationEndpointAuthMethod: "client_secret_basic",
      }),
    ).toBe(true);
    expect(valid(metadataDocument)).toBe(true);
    // Without scopes, the server could grant its defaults to a public client.
    expect(valid({ ...metadataDocument, scopes: [] })).toBe(false);
    // A public client has no secret to authenticate with.
    expect(valid({ ...metadataDocument, revocationEndpointAuthMethod: "client_secret_post" })).toBe(
      false,
    );
  });

  it("keeps unconfigured runtimes disabled and rejects credentials selected by a caller", async () => {
    const disabled = managedOAuth({ WIDEFLEET_SECRETS_KEYS: environment.WIDEFLEET_SECRETS_KEYS });

    expect(
      await disabled.request(identity, { action: "configuration", client: "google" }),
    ).toBeNull();
    const broker = managedOAuth(environment);

    expect(await broker.request(identity, { action: "configuration", client: "google" })).toEqual({
      clientId: "test-client",
      scopes: [...gmail],
    });
    expect(await broker.request(identity, { action: "configuration", client: "slack" })).toBeNull();

    const input = { action: "configuration", client: "google", clientSecret: "attacker" } as const;

    await expect(broker.request(identity, input)).rejects.toThrow();
    expect(
      await broker.handle(
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
    const cancelled = await broker.handle(new Request(callback), async () => true);
    const destination = new URL(z.string().parse(cancelled?.headers.get("location")));

    expect(destination.searchParams.get("error")).toBe("access_denied");
    expect(destination.searchParams.has("code")).toBe(false);
    callback.searchParams.set("iss", "https://attacker.example.test");
    expect((await broker.handle(new Request(callback), async () => true))?.status).toBe(400);
    callback.searchParams.delete("iss");
    callback.pathname = "/oauth/callback/github";
    expect((await broker.handle(new Request(callback), async () => true))?.status).toBe(400);
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
      expect(await broker.handle(new Request(`${identity.origin}${path}`), available)).toBeNull();
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

describe("managed OAuth with a Client ID Metadata Document", () => {
  const documentUrl = "https://oauth.example.test/oauth/client-metadata.json";

  const metadataEnvironment = {
    WIDEFLEET_SECRETS_KEYS: environment.WIDEFLEET_SECRETS_KEYS,
    WIDEFLEET_OAUTH: JSON.stringify({
      origin: "https://oauth.example.test",
      clients: {
        github: {
          provider: "github",
          clientId: "test-github",
          clientSecret: "test-github-secret",
          scopes: ["read:user"],
          hosts: ["https://api.github.com"],
        },
        tracker: {
          registration: "client-id-metadata-document",
          authorizationUrl: "https://auth.tracker.example.test/authorize",
          tokenUrl: "https://auth.tracker.example.test/token",
          resource: "https://mcp.tracker.example.test/mcp",
          issuer: "https://auth.tracker.example.test",
          revocationUrl: "https://auth.tracker.example.test/revoke",
          scopes: ["read", "write"],
          hosts: ["https://mcp.tracker.example.test"],
        },
        notes: {
          registration: "client-id-metadata-document",
          authorizationUrl: "https://notes.example.test/oauth/authorize",
          tokenUrl: "https://notes.example.test/oauth/token",
          scopes: ["notes"],
          hosts: ["https://notes.example.test"],
        },
      },
    }),
  };

  const authorizeTracker = async (broker = managedOAuth(metadataEnvironment)) => {
    const result = z.object({ url: z.url() }).parse(
      await broker.request(identity, {
        action: "authorize",
        client: "tracker",
        scopes: ["read"],
        state: "local-state",
        codeVerifier: verifier,
      }),
    );

    const url = new URL(result.url);

    return { broker, url, ticket: z.string().parse(url.searchParams.get("state")) };
  };

  it("publishes one document naming the callbacks of its metadata document clients", async () => {
    const broker = managedOAuth(metadataEnvironment);
    const response = await broker.handle(new Request(documentUrl), async () => true);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response?.json()).toEqual({
      client_id: documentUrl,
      client_name: "Widefleet",
      redirect_uris: [
        "https://oauth.example.test/oauth/callback/notes",
        "https://oauth.example.test/oauth/callback/tracker",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(
      (await broker.handle(new Request(documentUrl, { method: "POST" }), async () => true))?.status,
    ).toBe(405);
    expect(
      await broker.handle(
        new Request(`${identity.origin}/oauth/client-metadata.json`),
        async () => true,
      ),
    ).toBeNull();

    const named = managedOAuth({
      ...metadataEnvironment,
      WIDEFLEET_OAUTH: JSON.stringify({
        ...managedOAuthConfiguration.parse(JSON.parse(metadataEnvironment.WIDEFLEET_OAUTH)),
        clientName: "Example Apps",
      }),
    });

    expect(
      await (await named.handle(new Request(documentUrl), async () => true))?.json(),
    ).toMatchObject({ client_name: "Example Apps" });

    // Registered clients alone publish no document.
    expect(
      await managedOAuth(environment).handle(new Request(documentUrl), async () => true),
    ).toBeNull();
  });

  it("identifies itself by the document URL and never sends a client secret", async () => {
    const { broker, url, ticket } = await authorizeTracker();

    expect(await broker.request(identity, { action: "configuration", client: "tracker" })).toEqual({
      clientId: documentUrl,
      scopes: ["read", "write"],
    });
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.tracker.example.test/authorize");
    expect(url.searchParams.get("client_id")).toBe(documentUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://oauth.example.test/oauth/callback/tracker",
    );
    expect(url.searchParams.get("resource")).toBe("https://mcp.tracker.example.test/mcp");
    expect(url.searchParams.get("scope")).toBe("read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );

    const callback = await broker.handle(
      new Request(
        `https://oauth.example.test/oauth/callback/tracker?state=${encodeURIComponent(ticket)}&code=one-time-code&iss=https://auth.tracker.example.test`,
      ),
      async () => true,
    );

    const destination = new URL(z.string().parse(callback?.headers.get("location")));

    expect(destination.origin).toBe(identity.origin);
    expect(destination.pathname).toBe("/auth/callback/tracker");
    expect(destination.searchParams.get("managed_state")).toBe(ticket);

    tokenResponse = () =>
      Response.json({
        access_token: "tracker-access",
        refresh_token: "tracker-refresh",
        expires_in: 3600,
        scope: "read",
        token_type: "Bearer",
      });

    const granted = tokens.parse(
      await broker.request(identity, {
        action: "exchange",
        client: "tracker",
        ticket,
        code: "one-time-code",
        codeVerifier: verifier,
      }),
    );

    const exchange = requests.at(-1);

    expect(exchange?.url).toBe("https://auth.tracker.example.test/token");
    expect(Object.fromEntries(exchange?.body ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "one-time-code",
      code_verifier: verifier,
      redirect_uri: "https://oauth.example.test/oauth/callback/tracker",
      resource: "https://mcp.tracker.example.test/mcp",
      client_id: documentUrl,
    });
    expect(granted.accessToken).not.toContain("tracker-access");
    expect(
      await openAccessToken(
        metadataEnvironment,
        identity.appId,
        granted.accessToken,
        new URL("https://mcp.tracker.example.test/mcp"),
      ),
    ).toBe("tracker-access");
    expect(
      await openAccessToken(
        metadataEnvironment,
        identity.appId,
        granted.accessToken,
        new URL("https://notes.example.test/api"),
      ),
    ).toBeNull();

    await broker.request(identity, {
      action: "refresh",
      client: "tracker",
      refreshToken: granted.refreshToken,
    });
    expect(Object.fromEntries(requests.at(-1)?.body ?? [])).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "tracker-refresh",
      resource: "https://mcp.tracker.example.test/mcp",
      client_id: documentUrl,
    });

    expect(
      await broker.request(identity, {
        action: "revoke",
        client: "tracker",
        token: granted.refreshToken,
      }),
    ).toEqual({ revoked: true });
    expect(requests.at(-1)?.url).toBe("https://auth.tracker.example.test/revoke");
    expect(Object.fromEntries(requests.at(-1)?.body ?? [])).toEqual({
      token: "tracker-refresh",
      client_id: documentUrl,
    });
    expect(JSON.stringify(requests.map(({ body }) => [...body]))).not.toContain("secret");
  });

  it("does not expose or log the authorization server's error responses", async () => {
    const { broker, ticket } = await authorizeTracker();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    tokenResponse = () =>
      Response.json(
        { error: "invalid_grant", error_description: "provider-secret-response" },
        { status: 400 },
      );

    await expect(
      broker.request(identity, {
        action: "exchange",
        client: "tracker",
        ticket,
        code: "code",
        codeVerifier: verifier,
      }),
    ).rejects.not.toThrow("provider-secret-response");
    expect(JSON.stringify([logged.mock.calls, warned.mock.calls])).not.toContain(
      "provider-secret-response",
    );
    logged.mockRestore();
    warned.mockRestore();
  });

  it("omits the resource when the client names none and keeps its callback separate", async () => {
    const broker = managedOAuth(metadataEnvironment);

    const result = z.object({ url: z.url() }).parse(
      await broker.request(identity, {
        action: "authorize",
        client: "notes",
        scopes: ["notes"],
        state: "local-state",
        codeVerifier: verifier,
      }),
    );

    const url = new URL(result.url);

    expect(url.searchParams.has("resource")).toBe(false);
    const ticket = z.string().parse(url.searchParams.get("state"));

    // A ticket issued for one metadata document client is refused on another's callback.
    expect(
      (
        await broker.handle(
          new Request(
            `https://oauth.example.test/oauth/callback/tracker?state=${encodeURIComponent(ticket)}&code=code`,
          ),
          async () => true,
        )
      )?.status,
    ).toBe(400);
  });

  it.each([
    { clientSecret: "secret" },
    { clientId: "registered-id" },
    { authorizationUrl: "http://auth.tracker.example.test/authorize" },
    { hosts: ["https://mcp.tracker.example.test/mcp"] },
  ])(
    "rejects metadata document clients with registration credentials or invalid URLs (%o)",
    (change) => {
      const configured = managedOAuthConfiguration.parse(
        JSON.parse(metadataEnvironment.WIDEFLEET_OAUTH),
      );

      expect(
        managedOAuthConfiguration.safeParse({
          ...configured,
          clients: { tracker: { ...configured.clients["tracker"], ...change } },
        }).success,
      ).toBe(false);
    },
  );
});
