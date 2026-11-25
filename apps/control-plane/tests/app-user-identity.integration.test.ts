import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { issuer } from "@platform/auth-proxy/identity";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { createAppUserIdentity } from "../src/lib/server/app-user-identity.ts";
import { registerAppLogin } from "../src/lib/server/app-login-client.ts";
import { account, organization, ssoProvider, user } from "../src/lib/server/auth-schema.ts";
import type { Principal } from "../src/lib/server/identity.ts";
import { organizationRuntimes, organizationSettings } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";
import { createIdentityProvider, objectId, tenantId } from "./edge/auth-proxy-idp.ts";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

const token = (claims: { sub: string; oid?: string; tid?: string }) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

describe("App identity of management accounts", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let provider: Awaited<ReturnType<typeof createIdentityProvider>>;
  let auth: ReturnType<typeof createAuthentication>;
  let identify: ReturnType<typeof createAppUserIdentity>;
  let organizationId: string;
  let providerId: string;
  const origin = "http://localhost:25431";

  beforeAll(async () => {
    environment = await createTestEnvironment(origin);
    identify = createAppUserIdentity(
      environment.database.db,
      environment.configuration,
      environment.settings,
    );
  });
  afterAll(async () => {
    await environment.close();
  });
  beforeEach(async () => {
    organizationId = crypto.randomUUID();
    providerId = `company-${organizationId}`;
    provider = await createIdentityProvider(`${origin}/api/auth/sso/callback/${providerId}`, false);
    provider.settings.entra = true;
    provider.settings.email = `${organizationId}@example.test`;

    auth = createAuthentication(environment.configuration, environment.database.db, {
      organizationAccess: {
        filterOrganizations: async (candidates) =>
          candidates.filter(({ id }) => id === organizationId).map(({ id }) => id),
      },
    });
    await environment.database.db.insert(organization).values({
      id: organizationId,
      name: "App identity fixture",
      slug: providerId,
      createdAt: new Date(),
    });
    await environment.database.db.insert(organizationRuntimes).values({ organizationId });
    await environment.database.db
      .insert(organizationSettings)
      .values({ organizationId, settings: {}, ssoRequired: true });
    const { adapter } = await auth.$context;
    await adapter.create({
      model: "ssoProvider",
      data: {
        providerId,
        organizationId,
        issuer: `${provider.origin}/${tenantId}/v2.0`,
        domain: "example.test",
        domainVerified: true,
        appIdentityType: "entra",
        oidcConfig: JSON.stringify({
          issuer: `${provider.origin}/${tenantId}/v2.0`,
          discoveryEndpoint: `${provider.origin}/${tenantId}/v2.0/.well-known/openid-configuration`,
          clientId: "app-login",
          clientSecret: "synthetic-client-secret",
          scopes: ["openid", "profile", "email"],
          pkce: true,
          mapping: { name: "name", email: "email", extraFields: { groups: "groups" } },
        }),
      },
    });
  });
  afterEach(async () => {
    await provider.stop();
  });

  const login = async () => {
    const started = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ providerId, callbackURL: "/apps" }),
      }),
    );

    expect(started.status).toBe(200);
    const { url } = z.object({ url: z.url() }).parse(await started.json());
    const authorized = await fetch(url, { redirect: "manual" });

    const completed = await auth.handler(
      new Request(z.url().parse(authorized.headers.get("location")), {
        headers: { cookie: cookies(started) },
      }),
    );

    const current = await auth.api.getSession({
      headers: new Headers({ cookie: cookies(completed) }),
    });

    return { completed, userId: current?.user.id };
  };

  const principal = (id: string): Principal => ({
    id,
    name: "Example User",
    email: provider.settings.email,
    admin: false,
    creator: false,
    role: "member",
    application: { organizationId, admin: false },
  });

  it("keys Entra accounts by object ID, the subject app sign-in issues", async () => {
    // The fixture's pairwise `sub` differs from the object ID.
    expect(provider.settings.subject).not.toBe(objectId);
    const { completed, userId } = await login();
    expect(completed.headers.get("location")).toBe("/apps");
    const id = z.string().parse(userId);

    expect(
      await environment.database.db
        .select({ accountId: account.accountId })
        .from(account)
        .where(and(eq(account.providerId, providerId), eq(account.userId, id))),
    ).toEqual([{ accountId: objectId }]);

    const identity = await identify(principal(id));
    expect(identity).toEqual({
      issuer: `${provider.origin}/${tenantId}/v2.0`,
      subject: objectId,
      name: "Example User",
    });

    // The runtime accepts the identity only from the provider app sign-in publishes.
    await environment.settings.publish(organizationId);
    const published = environment.authControl.read(organizationId).configuration;

    if (!published) throw new Error("App sign-in was not published");
    expect(identity.issuer).toBe(issuer(published.provider));

    // A repeated sign-in finds the same account.
    expect((await login()).userId).toBe(id);
  });

  it("rejects Entra sign-in for another tenant without creating an account", async () => {
    provider.settings.failure = "tenant";
    const { completed, userId } = await login();
    expect(completed.headers.get("location")).toContain("error=");
    expect(userId).toBeUndefined();
    expect(
      await environment.database.db
        .select()
        .from(account)
        .where(eq(account.providerId, providerId)),
    ).toEqual([]);
  });

  it("keeps the standard subject for other providers", async () => {
    await environment.database.db
      .update(ssoProvider)
      .set({ appIdentityType: "oidc" })
      .where(eq(ssoProvider.providerId, providerId));
    const { userId } = await login();

    expect(
      await environment.database.db
        .select({ accountId: account.accountId })
        .from(account)
        .where(eq(account.providerId, providerId)),
    ).toEqual([{ accountId: provider.settings.subject }]);
    expect(userId).toBeTruthy();
  });

  it("names the Widefleet account when apps sign in through Widefleet", async () => {
    const id = z.string().parse((await login()).userId);
    await environment.database.db
      .update(organizationSettings)
      .set({ ssoRequired: false })
      .where(eq(organizationSettings.organizationId, organizationId));
    await registerAppLogin(
      environment.database.db,
      environment.configuration,
      environment.encryption,
      organizationId,
    );

    expect(await identify(principal(id))).toEqual({
      issuer: `${environment.configuration.PLATFORM_URL}/api/auth`,
      subject: id,
      name: "Example User",
    });

    // App sign-in through Widefleet admits only verified addresses.
    await environment.database.db.update(user).set({ emailVerified: false }).where(eq(user.id, id));
    await expect(identify(principal(id))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a member without a company account, such as a recovery session", async () => {
    const recovery = environment.users.createUser({ email: `recovery-${organizationId}@x.test` });
    await environment.users.saveUser(recovery);
    await expect(identify(principal(recovery.id))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("migrates saved Entra accounts to object IDs", async () => {
    const owner = z.string().parse((await login()).userId);
    const entra = crypto.randomUUID();
    const unreadable = crypto.randomUUID();
    const social = crypto.randomUUID();

    await environment.database.db.delete(account).where(eq(account.providerId, providerId));
    await environment.database.db.insert(account).values([
      {
        id: entra,
        providerId,
        accountId: "pairwise-subject",
        userId: owner,
        idToken: token({ sub: "pairwise-subject", oid: objectId, tid: tenantId }),
        accessToken: "company-access",
        refreshToken: "company-refresh",
      },
      {
        // An ID token that is not a readable JWT keeps its account unchanged.
        id: unreadable,
        providerId,
        accountId: "other-subject",
        userId: owner,
        idToken: "a1b2c3d4e5f6",
      },
      {
        id: social,
        providerId: "widefleet-google",
        accountId: "social-subject",
        userId: owner,
        idToken: token({ sub: "social-subject" }),
        accessToken: "social-access",
      },
    ]);

    const migration = await readFile(
      new URL("../migrations/0034_sso_account_identity.sql", import.meta.url),
      "utf8",
    );

    for (const statement of migration.split("--> statement-breakpoint"))
      await environment.database.db.execute(sql.raw(statement));

    const rows = await environment.database.db
      .select({ id: account.id, accountId: account.accountId })
      .from(account)
      .where(eq(account.userId, owner));

    expect(Object.fromEntries(rows.map((row) => [row.id, row.accountId]))).toEqual({
      [entra]: objectId,
      [unreadable]: "other-subject",
      [social]: "social-subject",
    });
    await environment.database.db.delete(account).where(eq(account.id, unreadable));

    // The migrated account still signs in as the same person.
    expect((await login()).userId).toBe(owner);
  });
});
