import { authConfiguration, createAuthProxy, type AppUserActivity } from "@platform/auth-proxy";
import { embeddingOrigin } from "@platform/contracts";
import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createBrowserServer } from "./auth-proxy-https.ts";

const tenantId = "00000000-0000-4000-8000-000000000001";

const clientId = "00000000-0000-4000-8000-000000000002";

const userId = "00000000-0000-4000-8000-000000000003";

const authority = "https://login.microsoftonline.com";

const app = "https://ledger.apps.example.test/";

const signIn = "https://auth.apps.example.test/oauth2/widefleet/embedded";

const host = "https://portal.embedder.test";

const configuration = authConfiguration.parse({
  organizationId: "widefleet",
  provider: { type: "entra", tenantId },
  clientId,
  clientSecret: "synthetic-client-secret",
  cookieSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  domain: "apps.example.test",
  redirectUrl: "https://auth.apps.example.test/oauth2/widefleet/callback",
  embeddingOrigins: [host, "https://*.teams.example.test"],
});

// The token endpoint's synthetic reply for the next exchange.
const providerReply = z.object({
  status: z.number(),
  body: z.record(z.string(), z.union([z.string(), z.array(z.number())])),
});

const hostClaims = z
  .object({
    ver: z.string(),
    tid: z.string(),
    scp: z.string().optional(),
    roles: z.array(z.string()),
  })
  .partial();

describe("embedded app sign-in", () => {
  let signingKey: CryptoKey;
  let publicKey: JWK;
  let allowedGroups: string[];
  let exchange: z.infer<typeof providerReply>;
  let memberships: string[];
  let mailbox: string | null;
  const exchanges: URLSearchParams[] = [];

  const apps = {
    resolve: (hostname: string) =>
      Promise.resolve(
        hostname === new URL(app).hostname ? { revision: 0, groups: allowedGroups } : null,
      ),
    fetch: (request: Request) =>
      Promise.resolve(Response.json(Object.fromEntries(request.headers))),
  };

  const proxy = (input = configuration) => createAuthProxy(input, apps);

  const hostToken = (claims: z.infer<typeof hostClaims> = {}, audience = clientId) =>
    new SignJWT({ ver: "2.0", tid: tenantId, oid: userId, scp: "access_as_user", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "host-key" })
      .setIssuer(`${authority}/${tenantId}/v2.0`)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signingKey);

  const submit = async (token: string, headers: Record<string, string> = {}) =>
    proxy().fetch(
      new Request(signIn, {
        method: "POST",
        headers: {
          origin: "https://auth.apps.example.test",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ token }),
      }),
    );

  // The cookies a browser keeps from a response, as one request header.
  const sessionCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .filter((cookie) => !cookie.includes("Max-Age=0"))
      .map((cookie) => cookie.split(";")[0] ?? "")
      .join("; ");

  const framed = (cookie = "") =>
    proxy().fetch(
      new Request(app, {
        headers: { accept: "text/html", "sec-fetch-dest": "iframe", cookie },
      }),
    );

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");

    signingKey = keys.privateKey;
    publicKey = { ...(await exportJWK(keys.publicKey)), kid: "host-key", alg: "RS256" };
  });

  beforeEach(() => {
    allowedGroups = [];
    memberships = ["00000000-0000-4000-8000-0000000000aa"];
    mailbox = "user@example.test";
    exchanges.length = 0;
    exchange = { status: 200, body: { access_token: "graph-access-token" } };

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.href === `${authority}/${tenantId}/discovery/v2.0/keys`)
        return Response.json({ keys: [publicKey] });

      if (url.href === `${authority}/${tenantId}/oauth2/v2.0/token`) {
        exchanges.push(new URLSearchParams(await request.text()));

        return Response.json(exchange.body, { status: exchange.status });
      }

      expect(request.headers.get("authorization")).toBe("Bearer graph-access-token");

      if (url.pathname === "/v1.0/me")
        return Response.json({
          id: userId,
          displayName: "Embedded User",
          mail: mailbox,
          userPrincipalName: "user@tenant.example.test",
        });

      if (url.pathname === "/v1.0/me/transitiveMemberOf")
        return Response.json({ value: memberships.map((id) => ({ id })) });

      return new Response(null, { status: 404 });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("requires Entra app identity", () => {
    expect(
      authConfiguration.safeParse({
        ...configuration,
        provider: { type: "google", domain: "example.test" },
      }).success,
    ).toBe(false);
  });

  it("sends framed navigations to the embedded sign-in page", async () => {
    const response = await framed();
    const location = new URL(z.string().parse(response.headers.get("location")));

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(signIn);
    expect(location.searchParams.get("rd")).toBe(app);

    const page = await proxy().fetch(new Request(location));

    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      `frame-ancestors ${host} https://*.teams.example.test`,
    );
    expect(await page.text()).toContain("widefleet:host-token-request");

    const topLevel = await proxy().fetch(new Request(app, { headers: { accept: "text/html" } }));

    expect(z.string().parse(topLevel.headers.get("location"))).toContain(
      "/oauth2/widefleet/start?",
    );
  });

  it("rejects unregistered destinations and unconfigured organizations", async () => {
    const foreign = await proxy().fetch(
      new Request(`${signIn}?rd=${encodeURIComponent("https://other.example.test/")}`),
    );

    expect(foreign.status).toBe(400);

    const disabled = await proxy({ ...configuration, embeddingOrigins: undefined }).fetch(
      new Request(`${signIn}?rd=${encodeURIComponent(app)}`),
    );

    expect(disabled.status).toBe(404);
    expect((await framed()).headers.get("location")).toContain("/oauth2/widefleet/embedded?");
  });

  it("signs in with a host token and forwards the same identity as company sign-in", async () => {
    const token = await hostToken();
    const signedIn = await submit(token);

    expect(signedIn.status).toBe(204);
    expect(exchanges[0]?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(exchanges[0]?.get("requested_token_use")).toBe("on_behalf_of");
    expect(exchanges[0]?.get("assertion")).toBe(token);
    expect(exchanges[0]?.get("client_id")).toBe(clientId);

    const cookie = z.string().parse(signedIn.headers.get("set-cookie"));

    expect(cookie).toMatch(/^__Secure-platform_sso_widefleet\.embedded_session=/);
    expect(cookie).toContain("Domain=apps.example.test");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
    expect(cookie).toContain("HttpOnly");

    const check = await proxy().fetch(
      new Request(`${signIn}/session`, { headers: { cookie: sessionCookie(signedIn) } }),
    );

    expect(check.status).toBe(204);

    const forwarded = z
      .record(z.string(), z.string())
      .parse(await (await framed(sessionCookie(signedIn))).json());

    expect(forwarded["x-auth-request-user"]).toBe(userId);
    expect(forwarded["x-auth-request-email"]).toBe("user@example.test");
    expect(forwarded["x-auth-request-groups"]).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(forwarded["cookie"]).toBeUndefined();
  });

  it("reports embedded sign-in as app user activity", async () => {
    const reported: AppUserActivity[] = [];
    const observe = (activity: AppUserActivity) => reported.push(activity);

    const signedIn = await createAuthProxy(configuration, { ...apps, observe }).fetch(
      new Request(signIn, {
        method: "POST",
        headers: {
          origin: "https://auth.apps.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: await hostToken() }),
      }),
    );

    expect(signedIn.status).toBe(204);
    expect(reported).toMatchObject([
      {
        trigger: "embedded_sign_in",
        issuer: `${authority}/${tenantId}/v2.0`,
        identity: { id: userId, email: "user@example.test" },
      },
    ]);
  });

  it("splits sessions with many groups across cookies and replaces them cleanly", async () => {
    memberships = Array.from(
      { length: 300 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    allowedGroups = [memberships.at(-1) ?? ""];
    const large = await submit(await hostToken());
    const names = large.headers.getSetCookie().map((cookie) => cookie.split("=")[0]);

    expect(names.length).toBeGreaterThan(2);
    expect(names[0]).toBe("__Secure-platform_sso_widefleet.embedded_session.0");
    expect(large.headers.getSetCookie().every((cookie) => cookie.length < 4_050)).toBe(true);
    expect((await framed(sessionCookie(large))).status).toBe(200);

    memberships = [];
    allowedGroups = [];

    const small = await proxy().fetch(
      new Request(signIn, {
        method: "POST",
        headers: {
          origin: "https://auth.apps.example.test",
          "content-type": "application/json",
          cookie: sessionCookie(large),
        },
        body: JSON.stringify({ token: await hostToken() }),
      }),
    );

    const expired = small.headers.getSetCookie().filter((cookie) => cookie.includes("Max-Age=0"));

    expect(expired).toHaveLength(names.length);
    expect(sessionCookie(small)).toMatch(/^__Secure-platform_sso_widefleet\.embedded_session=/);
  });

  it("uses the sign-in name of accounts without a mailbox", async () => {
    mailbox = null;
    const signedIn = await submit(await hostToken());

    const forwarded = z
      .record(z.string(), z.string())
      .parse(await (await framed(sessionCookie(signedIn))).json());

    expect(forwarded["x-auth-request-email"]).toBe("user@tenant.example.test");
  });

  it("compares embedding origins without the default port", () => {
    expect(embeddingOrigin.parse("https://Portal.example.test:443")).toBe(
      "https://portal.example.test",
    );
    expect(embeddingOrigin.parse("https://portal.example.test:8443")).toBe(
      "https://portal.example.test:8443",
    );
  });

  it("applies app access rules to embedded sessions", async () => {
    allowedGroups = ["00000000-0000-4000-8000-0000000000bb"];
    const signedIn = await submit(await hostToken());

    expect((await framed(sessionCookie(signedIn))).status).toBe(403);
  });

  it("asks the host again after the host token expires", async () => {
    const signedIn = await submit(await hostToken());

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);

    const expired = await framed(sessionCookie(signedIn));

    expect(expired.status).toBe(302);
    expect(expired.headers.get("location")).toContain("/oauth2/widefleet/embedded?");
  });

  it.each([
    ["another client", () => hostToken({}, "00000000-0000-4000-8000-000000000009")],
    ["another tenant", () => hostToken({ tid: "00000000-0000-4000-8000-000000000099" })],
    ["an app-only token", () => hostToken({ scp: undefined, roles: ["Read"] })],
    ["a v1 token", () => hostToken({ ver: "1.0" })],
  ])("rejects a token for %s", async (_, token) => {
    const response = await submit(await token());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_token" });
    expect(exchanges).toHaveLength(0);
  });

  it("accepts tokens only from its own sign-in page", async () => {
    const token = await hostToken();

    expect((await submit(token, { origin: host })).status).toBe(403);
    expect((await submit(token, { "content-type": "text/plain" })).status).toBe(403);
  });

  it("reports missing consent and provider outages", async () => {
    exchange = {
      status: 400,
      body: { error: "invalid_grant", suberror: "consent_required", error_codes: [65001] },
    };

    const consent = await submit(await hostToken());

    expect(consent.status).toBe(403);
    expect(await consent.json()).toEqual({ error: "consent_required" });

    exchange = { status: 503, body: { error: "temporarily_unavailable" } };
    expect((await submit(await hostToken())).status).toBe(503);
  });

  it("clears the embedded session on sign-out", async () => {
    const response = await proxy().fetch(
      new Request("https://auth.apps.example.test/oauth2/widefleet/sign_out", {
        method: "POST",
        headers: { origin: "https://auth.apps.example.test" },
      }),
    );

    expect(response.headers.getSetCookie().join("\n")).toContain(
      "__Secure-platform_sso_widefleet.embedded_session=; Domain=apps.example.test; Path=/; Max-Age=0",
    );
  });

  it.runIf(process.env["RUN_EDGE_TESTS"] === "1")(
    "shows an app in a cross-site frame with a partitioned session",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "embedded-sign-in-"));
      const token = await hostToken();

      // The host answers only Widefleet's sign-in page, never the app's own frame.
      const portal = (embedded: string) => `<!doctype html><title>Portal</title>
<iframe src="${embedded}" width="800" height="400"></iframe>
<script>
addEventListener("message", (event) => {
  if (event.origin !== "https://auth.apps.example.test") return;
  if (event.data?.type !== "widefleet:host-token-request") return;
  event.source.postMessage({ type: "widefleet:host-token", version: 1, token: ${JSON.stringify(token)} }, event.origin);
});
</script>`;

      const gateway = await createBrowserServer(directory, (request) => {
        const url = new URL(request.url);

        if (url.hostname === "portal.embedder.test" || url.hostname === "other.untrusted.test")
          return Promise.resolve(
            new Response(portal(`${app}report`), {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          );

        return proxy().fetch(request);
      });

      const browser = await chromium.launch({
        args: [
          `--host-resolver-rules=MAP *.apps.example.test 127.0.0.1:${gateway.port}, MAP *.embedder.test 127.0.0.1:${gateway.port}, MAP *.untrusted.test 127.0.0.1:${gateway.port}`,
        ],
      });

      try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();

        await page.goto(`${host}/`);
        const body = page.frameLocator("iframe").locator("body");

        await expect
          .poll(async () => (await body.innerText().catch(() => "")).includes(userId), {
            timeout: 15_000,
          })
          .toBe(true);

        const forwarded = z
          .record(z.string(), z.string())
          .parse(JSON.parse(await body.innerText()));

        expect(forwarded["sec-fetch-dest"]).toBe("iframe");
        expect(forwarded["x-auth-request-email"]).toBe("user@example.test");

        const session = (await context.cookies(app)).find((cookie) =>
          cookie.name.endsWith(".embedded_session"),
        );

        expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "None" });
        expect(session?.partitionKey).toBe("https://embedder.test");

        // Other top-level sites get neither the session nor the sign-in page.
        const other = await context.newPage();

        await other.goto("https://other.untrusted.test/");
        await other.waitForTimeout(1_000);
        expect(
          await other
            .frameLocator("iframe")
            .locator("body")
            .innerText({ timeout: 1_000 })
            .catch(() => ""),
        ).not.toContain(userId);
      } finally {
        await browser.close();
        await gateway.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
