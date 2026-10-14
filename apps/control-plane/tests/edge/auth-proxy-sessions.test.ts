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

  const login = async () => {
    const proxy = createAuthProxy(configuration, apps);

    const started = await proxy.fetch(
      new Request(`https://auth.apps.example.test/oauth2/start?rd=${encodeURIComponent(app)}`),
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
      redirectUrl: "https://auth.apps.example.test/oauth2/callback",
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
      "http://auth.apps.example.test/oauth2/callback",
      "https://evil.example.test/oauth2/callback",
      "https://auth.apps.example.test/oauth2/callback?redirect=elsewhere",
      "https://user@auth.apps.example.test/oauth2/callback",
    ]) {
      expect(authConfiguration.safeParse({ ...configuration, redirectUrl }).success).toBe(false);
    }

    expect(authConfiguration.safeParse({ ...configuration, cookieSecret: "weak" }).success).toBe(
      false,
    );
  });
});
