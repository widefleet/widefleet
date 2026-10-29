import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import { authenticationOptions } from "../src/lib/server/auth-options.ts";
import { runtimeConfigurationSchema } from "../src/lib/server/config.ts";
import {
  availableSocialProviders,
  socialSignInConfiguration,
} from "../src/lib/server/social-sign-in.ts";

const baseURL = "https://platform.example.test";

const email = "member@example.test";

const tenant = "11111111-1111-4111-8111-111111111111";

const oid = "22222222-2222-4222-8222-222222222222";

const configuration = {
  ...runtimeConfigurationSchema.parse({
    DATABASE_URL: "postgres://synthetic:synthetic@localhost/synthetic",
    PLATFORM_URL: baseURL,
    APP_DOMAIN: "apps.example.test",
    BETTER_AUTH_SECRET: "synthetic-social-sign-in-secret-never-deploy",
    GOOGLE_CLIENT_ID: "synthetic-google-client",
    GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
    MICROSOFT_CLIENT_ID: "synthetic-microsoft-client",
    MICROSOFT_CLIENT_SECRET: "synthetic-microsoft-secret",
  }),
  ARTIFACT_STORAGE_PROVIDER: "r2" as const,
};

describe("personal social sign-in", () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fixture = async ({
    localEmail = email,
    verified = true,
    admitted = true,
    existing = true,
  } = {}) => {
    let otp = "";
    let active = true;

    const options = authenticationOptions(configuration, {
      allowEmail: async () => admitted,
      allowUser: async () => active,
      sendEmail: async (message) => {
        otp = z
          .string()
          .regex(/^\d{6}$/)
          .parse(message.text.match(/code is (\d{6})/)?.[1]);
      },
      rateLimit: { enabled: false },
    });

    const user = existing
      ? {
          id: crypto.randomUUID(),
          email: localEmail,
          name: "Synthetic member",
          emailVerified: verified,
          createdAt: new Date(),
          updatedAt: new Date(),
          image: null,
        }
      : null;

    const auth = betterAuth({
      ...options,
      database: memoryAdapter({
        user: user ? [user] : [],
        session: [],
        account: [],
        verification: [],
        jwks: [],
        oauthResource: [],
      }),
      logger: { disabled: true },
    });

    const { internalAdapter } = await auth.$context;
    const cookies = new Map<string, string>();

    const receive = (response: Response) => {
      for (const cookie of response.headers.getSetCookie()) {
        const value = z.string().parse(cookie.split(";")[0]);
        const index = value.indexOf("=");
        cookies.set(value.slice(0, index), value.slice(index + 1));
      }

      return response;
    };

    const request = async (path: string, body?: z.infer<ReturnType<typeof z.json>>) =>
      receive(
        await auth.handler(
          new Request(`${baseURL}/api/auth${path}`, {
            method: body ? "POST" : "GET",
            headers: {
              origin: baseURL,
              "content-type": "application/json",
              cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
            },
            body: body ? JSON.stringify(body) : null,
          }),
        ),
      );

    const login = async () => {
      expect(
        (await request("/email-otp/send-verification-otp", { email: localEmail, type: "sign-in" }))
          .status,
      ).toBe(200);
      const response = await request("/sign-in/email-otp", { email: localEmail, otp });
      expect(response.status, await response.clone().text()).toBe(200);

      return response;
    };

    const start = async (provider: "google" | "microsoft", link = false) => {
      const response = await request(link ? "/link-social" : "/sign-in/social", {
        provider: `widefleet-${provider}`,
        callbackURL: "/device?user_code=SYNTHETIC",
        errorCallbackURL: `/sign-in/connect?provider=${provider}`,
        disableRedirect: true,
      });

      expect(response.status, await response.clone().text()).toBe(200);

      return new URL(z.object({ url: z.string() }).parse(await response.json()).url);
    };

    const complete = async (
      provider: "google" | "microsoft",
      authorization: URL,
      claims: ConstructorParameters<typeof SignJWT>[0],
      state = authorization.searchParams.get("state"),
    ) => {
      const idToken = await new SignJWT({
        name: "Synthetic provider user",
        email: localEmail,
        oid,
        tid: tenant,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
        .setIssuer(
          provider === "google"
            ? "https://accounts.google.com"
            : `https://login.microsoftonline.com/${z.string().parse(claims?.["tid"] ?? tenant)}/v2.0`,
        )
        .setAudience(`synthetic-${provider}-client`)
        .setSubject("synthetic-provider-subject")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: Parameters<typeof fetch>[0]) => {
          const url = new Request(input).url;
          expect(url).toBe(
            provider === "google"
              ? "https://oauth2.googleapis.com/token"
              : "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          );

          return Response.json({
            access_token: "synthetic-access-token",
            id_token: idToken,
            token_type: "Bearer",
            expires_in: 300,
          });
        }),
      );

      return request(
        `/callback/widefleet-${provider}?${new URLSearchParams({ state: state ?? "", code: "synthetic-code" })}`,
      );
    };

    const signIn = async (
      provider: "google" | "microsoft",
      claims: ConstructorParameters<typeof SignJWT>[0],
    ) => complete(provider, await start(provider), claims);

    return {
      auth,
      user,
      internalAdapter,
      request,
      login,
      start,
      complete,
      signIn,
      cookies,
      block: () => {
        active = false;
      },
    };
  };

  it.each([
    { provider: "google" as const, claims: { email_verified: true, hd: "example.test" } },
    { provider: "microsoft" as const, claims: { xms_edov: true } },
    {
      provider: "microsoft" as const,
      claims: { email_verified: true, tid: "9188040d-6c67-4c5b-b112-36a304b66dad" },
    },
  ])(
    "links a verified existing user through $provider and remembers the method",
    async ({ provider, claims }) => {
      const f = await fixture();
      const response = await f.signIn(provider, claims);
      expect(response.headers.get("location")).toBe("/device?user_code=SYNTHETIC");
      expect(await f.internalAdapter.findAccounts(z.string().parse(f.user?.id))).toMatchObject([
        { providerId: `widefleet-${provider}` },
      ]);
      expect(f.cookies.get("platform.last_used_login_method")).toBe(provider);
    },
  );

  it("accepts Gmail without a Workspace claim", async () => {
    const f = await fixture({ localEmail: "synthetic@gmail.com" });
    expect((await f.signIn("google", { email_verified: true })).headers.get("location")).toContain(
      "/device?",
    );
  });

  it.each(["google", "microsoft"] as const)(
    "requires email proof for %s, links after OTP, and recognizes the returning identity",
    async (provider) => {
      const f = await fixture();
      const untrusted = { email_verified: provider === "google" };
      expect((await f.signIn(provider, untrusted)).headers.get("location")).toContain(
        "error=account_not_linked",
      );
      expect(await f.internalAdapter.findAccounts(z.string().parse(f.user?.id))).toEqual([]);
      await f.login();
      expect(f.cookies.get("platform.last_used_login_method")).toBe("email-otp");
      const response = await f.complete(provider, await f.start(provider, true), untrusted);
      expect(response.headers.get("location")).toBe("/device?user_code=SYNTHETIC");
      expect(await f.internalAdapter.findAccounts(z.string().parse(f.user?.id))).toMatchObject([
        { providerId: `widefleet-${provider}` },
      ]);
      expect((await f.auth.$context).trustedProviders).not.toContain(`widefleet-${provider}`);
      f.cookies.clear();
      expect(
        (await f.signIn(provider, { ...untrusted, email: "changed@example.test" })).headers.get(
          "location",
        ),
      ).toContain("/device?");
      expect((await f.internalAdapter.findUserById(z.string().parse(f.user?.id)))?.email).toBe(
        email,
      );
    },
  );

  it.each(["google", "microsoft"] as const)(
    "does not create an unverified %s user before email confirmation",
    async (provider) => {
      const f = await fixture({ existing: false });
      expect((await f.signIn(provider, {})).headers.get("location")).toContain(
        "error=email_verification_required",
      );
      expect(await f.internalAdapter.findUserByEmail(email)).toBeNull();
      await f.login();
      expect(
        (await f.complete(provider, await f.start(provider, true), {})).headers.get("location"),
      ).toContain("/device?");
    },
  );

  it.each(["google", "microsoft"] as const)("enforces admission for %s", async (provider) => {
    const f = await fixture({ admitted: false });
    expect(
      (
        await f.signIn(provider, { email_verified: true, xms_edov: true, hd: "example.test" })
      ).headers.get("location"),
    ).toContain("error=sign_in_not_allowed");
    expect(await f.internalAdapter.findAccounts(z.string().parse(f.user?.id))).toEqual([]);
  });

  it("requires local email verification before automatic linking", async () => {
    const f = await fixture({ verified: false });
    expect((await f.signIn("microsoft", { xms_edov: true })).headers.get("location")).toContain(
      "error=email_verification_required",
    );
  });

  it("uses a Microsoft login name only as an unverified email hint", async () => {
    const f = await fixture();
    const claims = { email: undefined, preferred_username: email, xms_edov: true };
    expect((await f.signIn("microsoft", claims)).headers.get("location")).toContain(
      "error=account_not_linked",
    );
    await f.login();
    expect(
      (await f.complete("microsoft", await f.start("microsoft", true), claims)).headers.get(
        "location",
      ),
    ).toContain("/device?");
  });

  it("does not treat a legacy Microsoft SSO account as a personal provider link", async () => {
    const f = await fixture();
    const userId = z.string().parse(f.user?.id);
    await f.internalAdapter.createAccount({ userId, providerId: "microsoft", accountId: oid });
    expect((await f.signIn("microsoft", {})).headers.get("location")).toContain(
      "error=account_not_linked",
    );
    expect(await f.internalAdapter.findAccounts(userId)).toMatchObject([
      { providerId: "microsoft" },
    ]);
    await f.login();
    await f.complete("microsoft", await f.start("microsoft", true), {});
    expect(
      (await f.internalAdapter.findAccounts(userId)).map((account) => account.providerId).sort(),
    ).toEqual(["microsoft", "widefleet-microsoft"]);
  });

  it.each([
    { label: "stale", changes: { createdAt: new Date(0) } },
    { label: "company SSO", changes: { identityOrganizationId: "synthetic-company" } },
    { label: "recovery", changes: { recovery: true } },
  ])("rejects linking from a $label session", async ({ changes }) => {
    const f = await fixture();
    await f.login();
    const sessions = await f.internalAdapter.listSessions(z.string().parse(f.user?.id));
    await f.internalAdapter.updateSession(z.string().parse(sessions[0]?.token), changes);
    expect(
      (await f.request("/link-social", { provider: "widefleet-microsoft", callbackURL: "/apps" }))
        .status,
    ).toBe(403);
  });

  it("enforces account suspension again when a linking callback returns", async () => {
    const f = await fixture();
    await f.login();
    const authorization = await f.start("microsoft", true);
    f.block();
    expect((await f.complete("microsoft", authorization, {})).headers.get("location")).toContain(
      "error=sign_in_not_allowed",
    );
    expect(await f.internalAdapter.findAccounts(z.string().parse(f.user?.id))).toEqual([]);
  });

  it("does not retain linking trust or overwrite the last method after a failed login", async () => {
    const f = await fixture();
    await f.login();
    await f.complete("microsoft", await f.start("microsoft", true), {});
    f.cookies.clear();
    await f.signIn("microsoft", {});
    expect(f.cookies.get("platform.last_used_login_method")).toBe("microsoft");
    expect(
      (await f.signIn("microsoft", { oid: "33333333-3333-4333-8333-333333333333" })).headers.get(
        "location",
      ),
    ).toContain("error=account_not_linked");
    expect(f.cookies.get("platform.last_used_login_method")).toBe("microsoft");
  });

  it("rejects linking a different provider email even after OTP", async () => {
    const f = await fixture();
    await f.login();
    expect(
      (
        await f.complete("microsoft", await f.start("microsoft", true), {
          email: "someone-else@example.test",
        })
      ).headers.get("location"),
    ).toContain("error=");
    expect(await f.internalAdapter.findAccounts(z.string().parse(f.user?.id))).toEqual([]);
  });

  it("does not trust an unsigned callback state or replay an OAuth callback", async () => {
    const f = await fixture();
    const authorization = await f.start("microsoft");
    expect(
      (
        await f.complete("microsoft", authorization, { xms_edov: true }, "forged-state")
      ).headers.get("location"),
    ).toContain("error=");
    const fresh = await f.start("microsoft");
    expect(
      (await f.complete("microsoft", fresh, { xms_edov: true })).headers.get("location"),
    ).toContain("/device?");
    expect(
      (await f.complete("microsoft", fresh, { xms_edov: true })).headers.get("location"),
    ).toContain("error=");
  });

  it("requires the verified session to remain present when linking finishes", async () => {
    const f = await fixture();
    await f.login();
    const authorization = await f.start("microsoft", true);

    for (const key of f.cookies.keys()) if (key.includes("session_token")) f.cookies.delete(key);
    expect((await f.complete("microsoft", authorization, {})).headers.get("location")).toContain(
      "error=",
    );
    expect(await f.internalAdapter.findAccounts(z.string().parse(f.user?.id))).toEqual([]);
  });

  it("rejects alternate ID-token linking and cross-origin login initiation", async () => {
    const f = await fixture();
    expect(
      (
        await f.request("/sign-in/social", {
          provider: "widefleet-microsoft",
          idToken: { token: "synthetic" },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await f.auth.handler(
          new Request(`${baseURL}/api/auth/sign-in/social`, {
            method: "POST",
            headers: {
              origin: "https://other.example.test",
              "content-type": "application/json",
              "sec-fetch-site": "cross-site",
              "sec-fetch-mode": "cors",
              cookie: "platform.session_token=synthetic",
            },
            body: JSON.stringify({ provider: "widefleet-google" }),
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("only advertises configured providers and rejects partial credentials", () => {
    expect(availableSocialProviders(configuration)).toEqual(["google", "microsoft"]);
    expect(
      availableSocialProviders({
        ...configuration,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
      }),
    ).toEqual(["microsoft"]);
    expect(socialSignInConfiguration.safeParse({ GOOGLE_CLIENT_ID: "synthetic" }).success).toBe(
      false,
    );
  });
});
