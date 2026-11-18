import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { settingsInput } from "@platform/contracts";
import { account, member, organization, ssoProvider } from "../src/lib/server/auth-schema.ts";
import { organizationSettings } from "../src/lib/server/schema.ts";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createAuthenticationAdmission } from "../src/lib/server/auth-admission.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import { createAppSignIn } from "../src/lib/server/app-sign-in-node.ts";
import {
  createTestEnvironment,
  organizationCredential,
  linkCompanyAccount,
} from "./environment.ts";
import { editableSettings } from "./settings-input.ts";
import { createIdentityProvider } from "./edge/auth-proxy-idp.ts";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((value) => !value.includes("Max-Age=0"))
    .map((value) => value.split(";")[0])
    .join("; ");

describe("Operator-trusted self-hosted SSO", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let provider: Awaited<ReturnType<typeof createIdentityProvider>>;
  const origin = "http://localhost:25430";
  const providerId = "operator-company";

  beforeEach(async () => {
    environment = await createTestEnvironment(origin, "entra", { trustProvider: true });
    provider = await createIdentityProvider(`${origin}/api/auth/sso/callback/${providerId}`, false);
    await environment.database.db.delete(ssoProvider);
    await environment.database.db.update(organizationSettings).set({ ssoRequired: false });
    const { headers } = await environment.users.login({ userId: environment.owner.id });
    await environment.settings.initialize(
      settingsInput.parse({
        sso: {
          providerId,
          issuer: provider.origin,
          oidcConfig: {
            clientId: "app-login",
            clientSecret: "synthetic-client-secret",
            mapping: { email: "mail", name: "display_name" },
          },
        },
      }),
      "widefleet",
      { auth: environment.auth, headers },
    );
  });

  afterEach(async () => {
    await provider.stop();
    await environment.close();
  });

  const principal = () => ({
    ...environment.owner,
    role: "owner" as const,
    admin: true,
    creator: true,
    application: { organizationId: "widefleet", admin: true },
  });

  const login = async (auth = environment.auth) => {
    const started = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ providerId, callbackURL: "/apps" }),
      }),
    );

    expect(started.status, await started.clone().text()).toBe(200);
    const { url } = z.object({ url: z.url() }).parse(await started.json());
    const authorized = await fetch(url, { redirect: "manual" });

    const completed = await auth.handler(
      new Request(z.url().parse(authorized.headers.get("location")), {
        headers: { cookie: cookies(started) },
      }),
    );

    const headers = new Headers({ cookie: cookies(completed), origin });

    return { completed, headers, session: await auth.api.getSession({ headers }) };
  };

  it("activates a domainless provider, publishes app login and provisions stable member identities", async () => {
    await linkCompanyAccount(environment.database.db, principal().id);
    const activated = await environment.settings.activateSso(principal());
    expect(activated).toMatchObject({
      ssoRequired: true,
      ssoPolicy: { domainVerificationRequired: false, allowEmailAccountLinking: false },
      sso: { domain: "", domainVerified: false },
      activation: { state: "active" },
    });
    expect(environment.authControl.read().configuration?.clientId).toBe("app-login");
    const first = await login();
    expect(first.completed.headers.get("location")).toBe("/apps");
    const userId = z.string().parse(first.session?.user.id);
    expect(first.session?.session.identityOrganizationId).toBe("widefleet");
    expect(
      await environment.database.db.select().from(member).where(eq(member.userId, userId)),
    ).toEqual([expect.objectContaining({ organizationId: "widefleet", role: "member" })]);
    expect((await login()).session?.user.id).toBe(userId);

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
    );

    expect(
      (
        await identity.authenticate(
          new Request(origin, { headers: first.headers }),
          "platform:read",
        )
      ).isOk(),
    ).toBe(true);
    const email = await environment.users.login({ userId: environment.owner.id });
    expect(
      await identity.authenticate(new Request(origin, { headers: email.headers }), "platform:read"),
    ).toMatchObject({ error: { code: "SSO_REQUIRED" } });
    await expect(
      environment.auth.api.updateSSOProvider({
        headers: email.headers,
        body: { providerId, domain: "example.test" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const [stored] = await environment.database.db.select().from(ssoProvider);
    expect(stored?.domainVerified).toBe(false);
  });

  it("uses optional domains alongside verified domains and allows removing the last domain", async () => {
    await environment.database.db
      .update(ssoProvider)
      .set({ domain: "verified.example.test", domainVerified: true });
    await linkCompanyAccount(environment.database.db, principal().id);
    await environment.settings.activateSso(principal());
    const added = await environment.settings.addDomain(principal(), "optional.example.test", false);
    expect(added.ssoDomains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: "verified.example.test", verified: true }),
        expect.objectContaining({ domain: "optional.example.test", verified: false }),
      ]),
    );

    const admission = createAuthenticationAdmission(
      environment.database.db,
      undefined,
      false,
      environment.configuration,
    );

    expect(await admission.signInProvider("person@optional.example.test")).toBe(providerId);
    expect(
      await createAuthenticationAdmission(environment.database.db).signInProvider(
        "person@optional.example.test",
      ),
    ).toBeNull();
    await environment.settings.removeDomain(principal(), "verified.example.test", false);
    expect(await environment.settings.read(principal())).toMatchObject({
      ssoRequired: true,
      sso: { domainVerified: false },
    });

    const removed = await environment.settings.removeDomain(
      principal(),
      "optional.example.test",
      false,
    );

    expect(removed).toMatchObject({
      ssoDomains: [],
      sso: { domain: "", domainVerified: false },
      ssoRequired: true,
      activation: { state: "active" },
    });
    expect(await admission.signInProvider("person@optional.example.test")).toBeNull();
    expect((await login()).session?.user.id).toBeTruthy();
  });

  it("preserves omitted domains on updates and accepts an explicitly empty list", async () => {
    await environment.settings.addDomain(principal(), "first.example.test", false);
    await environment.settings.addDomain(principal(), "second.example.test", false);
    const credential = await organizationCredential(environment, principal());
    const next = editableSettings(await environment.settings.read(principal()));

    if (!next.sso) throw new Error("Missing fixture provider");
    delete next.sso.domain;
    await environment.settings.update(
      principal(),
      { ...next, acknowledgeRestart: false },
      false,
      credential,
    );
    expect((await environment.settings.read(principal())).ssoDomains).toHaveLength(2);
    next.sso.domain = "";

    const cleared = await environment.settings.update(
      principal(),
      { ...next, acknowledgeRestart: false },
      false,
      credential,
    );

    expect(cleared).toMatchObject({ ssoDomains: [], sso: { domain: "", domainVerified: false } });
    await linkCompanyAccount(environment.database.db, principal().id);
    expect((await environment.settings.activateSso(principal())).ssoRequired).toBe(true);
  });

  it("does not link matching email addresses by default, even after earlier DNS verification", async () => {
    provider.settings.email = environment.owner.email;
    await environment.database.db
      .update(ssoProvider)
      .set({ domain: "example.test", domainVerified: true });
    const result = await login();
    expect(result.session).toBeNull();
    expect(
      new URL(z.url().parse(result.completed.headers.get("location"))).searchParams.get("error"),
    ).toBe("account not linked");
    expect(
      await environment.database.db
        .select()
        .from(account)
        .where(eq(account.userId, environment.owner.id)),
    ).toEqual([]);
  });

  it.each([
    { verified: false, emailSignIn: false },
    { verified: false, emailSignIn: true },
    { verified: true, emailSignIn: false },
  ])("withdraws operator trust and republishes only an admitted login (%j)", async (options) => {
    await environment.database.db
      .update(ssoProvider)
      .set({ domain: "example.test", domainVerified: options.verified });
    await linkCompanyAccount(environment.database.db, principal().id);
    await environment.settings.activateSso(principal());
    expect(environment.authControl.read().configuration?.clientId).toBe("app-login");

    const configuration = {
      ...environment.configuration,
      PLATFORM_SSO_TRUST_PROVIDER: false,
    };

    const settings = createSettingsService(
      configuration,
      environment.database.db,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      (organizationId) =>
        createAppSignIn(configuration, Buffer.alloc(32, 1).toString("base64url"), organizationId),
      options.emailSignIn,
    );

    await settings.republish();
    const installed = environment.authControl.read().configuration;

    if (options.verified) expect(installed?.clientId).toBe("app-login");
    else if (options.emailSignIn) {
      expect(installed?.provider).toMatchObject({
        type: "oidc",
        issuer: `${origin}/api/auth`,
      });
      expect(installed?.clientId).not.toBe("app-login");
    } else {
      expect(installed).toBeNull();
      expect(await settings.read(principal())).toMatchObject({
        error: null,
        activation: { state: "waiting" },
      });
      await expect(
        createAuthentication(configuration, environment.database.db).api.signInSSO({
          body: { providerId, callbackURL: "/apps" },
        }),
      ).rejects.toThrow();
    }

    await environment.settings.republish();
    expect(environment.authControl.read().configuration?.clientId).toBe("app-login");
  });

  it("reports a failed trust withdrawal and retries it on republication", async () => {
    await linkCompanyAccount(environment.database.db, principal().id);
    await environment.settings.activateSso(principal());
    const configuration = { ...environment.configuration, PLATFORM_SSO_TRUST_PROVIDER: false };

    const settings = createSettingsService(
      configuration,
      environment.database.db,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      (organizationId) =>
        createAppSignIn(configuration, Buffer.alloc(32, 1).toString("base64url"), organizationId),
    );

    environment.authControl.available(false);
    await expect(settings.republish()).rejects.toThrow("App sign-in could not be prepared");
    environment.authControl.available(true);
    await settings.republish();
    expect(environment.authControl.read().configuration).toBeNull();
  });

  it("links existing accounts only with the operator option and preserves the owner and account binding", async () => {
    provider.settings.email = environment.owner.email;

    const auth = createAuthentication(
      { ...environment.configuration, PLATFORM_SSO_ALLOW_EMAIL_ACCOUNT_LINKING: true },
      environment.database.db,
    );

    const result = await login(auth);
    expect(result.session?.user).toMatchObject({
      id: environment.owner.id,
      name: environment.owner.name,
    });
    expect(
      await environment.database.db
        .select()
        .from(member)
        .where(eq(member.userId, environment.owner.id)),
    ).toEqual([expect.objectContaining({ role: "owner" })]);

    // A subsequent changed email claim must not select a different local user.
    const other = environment.users.createUser({
      email: "other@example.test",
      emailVerified: true,
    });

    await environment.users.saveUser(other);
    provider.settings.email = other.email;
    expect((await login(auth)).session?.user.id).toBe(environment.owner.id);
  });

  it.each(["issuer", "audience", "signature"])(
    "still rejects a token with the wrong %s",
    async (failure) => {
      provider.settings.failure = failure;
      const result = await login();
      expect(result.session).toBeNull();
      expect(result.completed.headers.get("location")).not.toBe("/apps");
      expect(
        await environment.database.db
          .select()
          .from(account)
          .where(eq(account.providerId, providerId)),
      ).toEqual([]);
    },
  );

  it("keeps hosted DNS enforcement even when operator flags are supplied", async () => {
    const configuration = {
      ...environment.configuration,
      ARTIFACT_STORAGE_PROVIDER: "r2" as const,
      PLATFORM_SSO_ALLOW_EMAIL_ACCOUNT_LINKING: true,
    };

    const auth = createAuthentication(configuration, environment.database.db);

    const settings = createSettingsService(
      configuration,
      environment.database.db,
      configuration.PLATFORM_ENCRYPTION_KEY ?? configuration.BETTER_AUTH_SECRET,
      () => null,
    );

    await expect(settings.activateSso(principal())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await settings.read(principal())).toMatchObject({
      ssoPolicy: { domainVerificationRequired: true, allowEmailAccountLinking: false },
    });
    await expect(
      auth.api.signInSSO({ body: { providerId, callbackURL: "/apps" } }),
    ).rejects.toThrow();
    const { headers } = await environment.users.login({ userId: environment.owner.id });
    await expect(
      auth.api.updateSSOProvider({ headers, body: { providerId, domain: "" } }),
    ).rejects.toThrow();
  });

  it("does not let API callers grant operator trust or enable account linking", () => {
    expect(settingsInput.safeParse({ sso: null, PLATFORM_SSO_TRUST_PROVIDER: true }).success).toBe(
      false,
    );
    expect(settingsInput.safeParse({ sso: null, allowEmailAccountLinking: true }).success).toBe(
      false,
    );
    expect(environment.auth.api).not.toHaveProperty("requestDomainVerification");
    expect(environment.auth.api).not.toHaveProperty("verifyDomain");
  });

  it("does not extend installation trust to another organization", async () => {
    await environment.database.db.insert(organization).values({
      id: "other-organization",
      slug: "other-organization",
      name: "Other organization",
      createdAt: new Date(),
    });
    await environment.database.db.update(ssoProvider).set({ organizationId: "other-organization" });

    const auth = createAuthentication(environment.configuration, environment.database.db, {
      organizationAccess: { filterOrganizations: async () => ["other-organization"] },
    });

    const otherPrincipal = {
      ...principal(),
      application: { organizationId: "other-organization", admin: true },
    };

    expect(await environment.settings.read(otherPrincipal)).toMatchObject({
      ssoPolicy: { domainVerificationRequired: true, allowEmailAccountLinking: false },
    });
    await expect(environment.settings.activateSso(otherPrincipal)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      auth.api.signInSSO({ body: { providerId, callbackURL: "/apps" } }),
    ).rejects.toThrow();
    expect(await environment.database.db.select().from(account)).toEqual([]);
  });

  it("requires a tenant-specific issuer for Entra and a Workspace domain for Google", async () => {
    for (const tenant of ["common", "organizations", "consumers"]) {
      await expect(
        environment.settings.plan(
          principal(),
          settingsInput.parse({
            sso: {
              providerId,
              appIdentityType: "entra",
              issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
              oidcConfig: { clientId: "app-login", clientSecret: "synthetic-client-secret" },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }

    await expect(
      environment.settings.plan(
        principal(),
        settingsInput.parse({
          sso: {
            providerId,
            appIdentityType: "google",
            issuer: "https://accounts.google.com",
            oidcConfig: { clientId: "app-login", clientSecret: "synthetic-client-secret" },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Enter a company email domain" });
  });
});
