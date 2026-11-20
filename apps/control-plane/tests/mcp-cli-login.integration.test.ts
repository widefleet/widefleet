import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { mcpCliLogin } from "@platform/auth-proxy/mcp-cli-login";
import { settingsInput } from "@platform/contracts";
import { account, ssoProvider, verification } from "../src/lib/server/auth-schema.ts";
import { createMcpCliLogin } from "../src/lib/server/mcp-cli-login.ts";
import { enrollCompanyUser } from "../src/lib/server/organization.ts";
import { organizationSettings } from "../src/lib/server/schema.ts";
import { createIdentityProvider } from "./edge/auth-proxy-idp.ts";
import { createTestEnvironment, linkCompanyAccount } from "./environment.ts";

const origin = "https://platform.example.test";

describe("CLI sign-in with an MCP login code", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let entraIssuer: string;
  let tenantId: string;

  beforeAll(async () => {
    // Operator trust makes the fixture's company SSO the published app identity provider.
    environment = await createTestEnvironment(origin, "entra", { trustProvider: true });
    tenantId = environment.environment.ENTRA_TENANT_ID;
    entraIssuer = `${new URL(environment.environment.ENTRA_AUTHORITY).origin}/${tenantId}/v2.0`;
  });

  afterAll(async () => {
    await environment?.close();
  });

  const startDevice = async () => {
    const created = await environment.auth.handler(
      new Request(`${origin}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "platform-cli",
          scope: "openid offline_access platform:read platform:write",
          resource: `${origin}/api/v1`,
        }),
      }),
    );

    expect(created.status, await created.clone().text()).toBe(200);

    return z.object({ user_code: z.string(), device_code: z.string() }).parse(await created.json());
  };

  const redeem = (code: string, userCode: string) =>
    environment.auth.handler(
      new Request(`${origin}/api/auth/mcp/cli-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, user_code: userCode }),
      }),
    );

  const exchange = (deviceCode: string) =>
    environment.auth.handler(
      new Request(`${origin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "platform-cli",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
        }),
      }),
    );

  const signIn = async (login: { issuer: string; subject: string }) => {
    const device = await startDevice();

    const code = await environment.authControl.signCliLogin({
      organizationId: "widefleet",
      ...login,
    });

    const redeemed = await redeem(code, device.user_code);

    return { device, code, redeemed };
  };

  const expectSignedIn = async (deviceCode: string, userId: string) => {
    const exchanged = await exchange(deviceCode);
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);

    const tokens = z
      .object({ access_token: z.string(), refresh_token: z.string() })
      .parse(await exchanged.json());

    expect(decodeJwt(tokens.access_token)).toMatchObject({
      sub: userId,
      reference_id: "organization:widefleet",
    });
  };

  const companyUser = async (email: string, member = true) => {
    const user = environment.users.createUser({ email });
    await environment.users.saveUser(user);

    if (member) await enrollCompanyUser(environment.database.db, user.id);

    return user;
  };

  it("approves the CLI's device request for the account of the registration's subject", async () => {
    const user = await companyUser("person@example.test", false);
    // Entra issues a subject per registration; the MCP connection used the same one.
    const subject = `pairwise-${crypto.randomUUID()}`;
    await environment.linkMicrosoftUser(user.id, subject);

    const { device, code, redeemed } = await signIn({ issuer: entraIssuer, subject });

    expect(redeemed.status, await redeemed.clone().text()).toBe(200);
    expect(redeemed.headers.get("cache-control")).toBe("no-store");
    await expectSignedIn(device.device_code, user.id);

    const replay = await startDevice();
    const replayed = await redeem(code, replay.user_code);
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toContain("already used");
    expect((await exchange(replay.device_code)).status).toBe(400);
  });

  it("rejects unknown identities, other issuers, non-members and forged codes", async () => {
    const outsider = await companyUser("outsider@example.test", false);
    const outsiderSubject = crypto.randomUUID();

    await environment.database.db.insert(account).values({
      id: crypto.randomUUID(),
      providerId: "microsoft",
      accountId: outsiderSubject,
      userId: outsider.id,
    });

    expect(
      (await signIn({ issuer: entraIssuer, subject: crypto.randomUUID() })).redeemed.status,
    ).toBe(403);
    expect(
      (await signIn({ issuer: "https://login.example.test/other/v2.0", subject: outsiderSubject }))
        .redeemed.status,
    ).toBe(403);
    expect((await signIn({ issuer: entraIssuer, subject: outsiderSubject })).redeemed.status).toBe(
      403,
    );

    const device = await startDevice();

    const code = await environment.authControl.signCliLogin({
      organizationId: "widefleet",
      issuer: entraIssuer,
      subject: outsiderSubject,
    });

    const [payload] = code.split(".");

    expect((await redeem(`${payload}.forged-signature`, device.user_code)).status).toBe(400);
    expect((await redeem("not-a-code", device.user_code)).status).toBe(400);
  });

  it("does not approve an unknown device request", async () => {
    const user = await companyUser("device@example.test", false);
    const objectId = crypto.randomUUID();
    await environment.linkMicrosoftUser(user.id, objectId);

    const code = await environment.authControl.signCliLogin({
      organizationId: "widefleet",
      issuer: entraIssuer,
      subject: objectId,
    });

    const unknown = await redeem(code, "UNKNOWN1");
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("device login");
  });

  it("rejects a code that expires after edge verification, even after its use record is removed", async () => {
    const user = await companyUser("expiry@example.test", false);
    const objectId = crypto.randomUUID();
    await environment.linkMicrosoftUser(user.id, objectId);

    const code = await environment.authControl.signCliLogin({
      organizationId: "widefleet",
      issuer: entraIssuer,
      subject: objectId,
    });

    const verified = mcpCliLogin.parse(
      await environment.settings.verifyCliLogin("widefleet", code),
    );

    const expired = { ...verified, expiresAt: Date.now() - 1 };

    // The first use's record has expired and is removed before this request claims the ID.
    await environment.database.db.insert(verification).values({
      id: `mcp-cli-login:${verified.id}`,
      identifier: `mcp-cli-login:${verified.id}`,
      value: "",
      expiresAt: new Date(expired.expiresAt),
    });

    const login = createMcpCliLogin(environment.database.db, environment.configuration, {
      resolve: (organizationId) => environment.settings.resolve(organizationId),
      verifyCliLogin: async () => expired,
    });

    const device = await startDevice();
    await expect(login.redeem(code, device.user_code)).rejects.toMatchObject({ statusCode: 400 });
    expect((await exchange(device.device_code)).status).toBe(400);
  });

  it("uses Widefleet user IDs when Widefleet is the app identity provider", async () => {
    await environment.database.db.update(organizationSettings).set({ ssoRequired: false });

    const user = await companyUser("email@example.test");
    const { device, redeemed } = await signIn({ issuer: `${origin}/api/auth`, subject: user.id });

    expect(redeemed.status, await redeemed.clone().text()).toBe(200);
    await expectSignedIn(device.device_code, user.id);

    expect(
      (await signIn({ issuer: entraIssuer, subject: crypto.randomUUID() })).redeemed.status,
    ).toBe(403);
  });
});

describe("Entra company SSO sign-in for MCP CLI logins", () => {
  const origin = "http://localhost:25430";
  const providerId = "company-entra";
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let provider: Awaited<ReturnType<typeof createIdentityProvider>>;
  let issuer: string;

  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .filter((value) => !value.includes("Max-Age=0"))
      .map((value) => value.split(";")[0])
      .join("; ");

  beforeAll(async () => {
    environment = await createTestEnvironment(origin, "entra", { trustProvider: true });
    provider = await createIdentityProvider(`${origin}/api/auth/sso/callback/${providerId}`, false);
    provider.settings.entra = true;
    issuer = `${provider.origin}/${environment.environment.ENTRA_TENANT_ID}/v2.0`;
    await environment.database.db.delete(ssoProvider);
    await environment.database.db.update(organizationSettings).set({ ssoRequired: false });

    const { headers } = await environment.users.login({ userId: environment.owner.id });

    await environment.settings.initialize(
      settingsInput.parse({
        sso: {
          appIdentityType: "entra",
          providerId,
          issuer,
          oidcConfig: {
            clientId: "app-login",
            clientSecret: "synthetic-client-secret",
            mapping: { email: "email", name: "name" },
          },
        },
      }),
      "widefleet",
      { auth: environment.auth, headers },
    );

    await linkCompanyAccount(environment.database.db, environment.owner.id);

    await environment.settings.activateSso({
      ...environment.owner,
      role: "owner",
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    });
  });

  afterAll(async () => {
    await provider?.stop();
    await environment?.close();
  });

  it("signs in the CLI with the subject that company SSO stored", async () => {
    const started = await environment.auth.handler(
      new Request(`${origin}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ providerId, callbackURL: "/apps" }),
      }),
    );

    expect(started.status, await started.clone().text()).toBe(200);
    const { url } = z.object({ url: z.url() }).parse(await started.json());
    const authorized = await fetch(url, { redirect: "manual" });

    const completed = await environment.auth.handler(
      new Request(z.url().parse(authorized.headers.get("location")), {
        headers: { cookie: cookies(started) },
      }),
    );

    const session = await environment.auth.api.getSession({
      headers: new Headers({ cookie: cookies(completed), origin }),
    });

    const userId = z.string().parse(session?.user.id);

    // Company SSO keys the account by the registration's subject, not the object ID.
    const [stored] = await environment.database.db
      .select({ accountId: account.accountId })
      .from(account)
      .where(eq(account.userId, userId));

    expect(stored).toEqual({ accountId: "pairwise-subject" });

    const created = await environment.auth.handler(
      new Request(`${origin}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "platform-cli",
          scope: "openid offline_access platform:read",
          resource: `${origin}/api/v1`,
        }),
      }),
    );

    const device = z.object({ user_code: z.string() }).parse(await created.json());

    const code = await environment.authControl.signCliLogin({
      organizationId: "widefleet",
      issuer,
      subject: "pairwise-subject",
    });

    const redeemed = await environment.auth.handler(
      new Request(`${origin}/api/auth/mcp/cli-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, user_code: device.user_code }),
      }),
    );

    expect(redeemed.status, await redeemed.clone().text()).toBe(200);
  });
});
