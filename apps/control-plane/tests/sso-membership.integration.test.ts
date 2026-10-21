import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createAuthentication } from "../src/lib/server/auth.ts";
import type { OrganizationAccess } from "../src/lib/server/application-context.ts";
import { account, invitation, member, organization, user } from "../src/lib/server/auth-schema.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { organizationRuntimes } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";
import { createIdentityProvider } from "./edge/auth-proxy-idp.ts";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

describe("Native SSO organization membership", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let provider: Awaited<ReturnType<typeof createIdentityProvider>>;
  let auth: ReturnType<typeof createAuthentication>;
  let identity: ReturnType<typeof createIdentityService>;
  let organizationId: string;
  let providerId: string;
  let admitted: boolean;
  const origin = "http://localhost:25430";

  beforeAll(async () => {
    environment = await createTestEnvironment(origin);
  });
  afterAll(async () => {
    await environment.close();
  });
  beforeEach(async () => {
    organizationId = crypto.randomUUID();
    providerId = `company-${organizationId}`;
    admitted = true;
    provider = await createIdentityProvider(`${origin}/api/auth/sso/callback/${providerId}`, false);
    provider.settings.email = `${organizationId}@example.test`;

    const organizationAccess = {
      filterOrganizations: async (candidates) =>
        candidates.filter(({ id }) => admitted && id === organizationId).map(({ id }) => id),
    } satisfies OrganizationAccess;

    auth = createAuthentication(environment.configuration, environment.database.db, {
      organizationAccess,
    });
    identity = createIdentityService(
      auth,
      environment.database.db,
      environment.configuration,
      organizationAccess,
    );
    await environment.database.db.insert(organization).values({
      id: organizationId,
      name: "SSO membership fixture",
      slug: providerId,
      createdAt: new Date(),
    });
    await environment.database.db.insert(organizationRuntimes).values({ organizationId });
    const { adapter } = await auth.$context;
    await adapter.create({
      model: "ssoProvider",
      data: {
        providerId,
        organizationId,
        issuer: provider.origin,
        domain: "example.test",
        domainVerified: true,
        oidcConfig: JSON.stringify({
          issuer: provider.origin,
          discoveryEndpoint: `${provider.origin}/.well-known/openid-configuration`,
          clientId: "app-login",
          clientSecret: "synthetic-client-secret",
          scopes: ["openid", "profile", "email"],
          pkce: true,
          mapping: { email: "mail", name: "display_name" },
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
    expect(authorized.status).toBe(302);

    const completed = await auth.handler(
      new Request(z.url().parse(authorized.headers.get("location")), {
        headers: { cookie: cookies(started) },
      }),
    );

    const headers = new Headers({ cookie: cookies(completed) });
    const current = await auth.api.getSession({ headers });

    return { completed, headers, current };
  };

  it.each(["example.test", "guest.test"])(
    "admits a new SSO user at %s without an invitation and preserves membership on repeat login",
    async (domain) => {
      provider.settings.email = `${organizationId}@${domain}`;
      const first = await login();
      expect(first.completed.headers.get("location")).toBe("/apps");
      expect(first.current?.user.email).toBe(provider.settings.email);
      expect(first.current?.user.emailVerified).toBe(domain === "example.test");
      expect(first.current?.session.identityOrganizationId).toBe(organizationId);
      const userId = z.string().parse(first.current?.user.id);

      const memberships = await environment.database.db
        .select()
        .from(member)
        .where(eq(member.userId, userId));

      expect(memberships).toEqual([expect.objectContaining({ organizationId, role: "member" })]);
      expect(
        (
          await identity.authenticate(
            new Request(`${origin}/api/v1/me`, { headers: first.headers }),
            "platform:read",
          )
        ).isOk(),
      ).toBe(true);
      const second = await login();
      expect(second.current?.user.id).toBe(userId);
      expect(
        await environment.database.db.select().from(member).where(eq(member.userId, userId)),
      ).toEqual(memberships);
    },
  );

  it("links an existing verified company address and adds its missing membership", async () => {
    const existing = environment.users.createUser({
      email: provider.settings.email,
      emailVerified: true,
    });

    await environment.users.saveUser(existing);
    const result = await login();
    expect(result.completed.headers.get("location")).toBe("/apps");
    expect(result.current?.user.id).toBe(existing.id);
    expect(
      await environment.database.db.select().from(member).where(eq(member.userId, existing.id)),
    ).toEqual([expect.objectContaining({ organizationId, role: "member" })]);
  });

  it("does not link an existing external account solely on the provider's email claim", async () => {
    provider.settings.email = `${organizationId}@guest.test`;

    const existing = environment.users.createUser({
      email: provider.settings.email,
      emailVerified: true,
    });

    await environment.users.saveUser(existing);
    const result = await login();
    expect(
      new URL(z.url().parse(result.completed.headers.get("location"))).searchParams.get("error"),
    ).toBe("account not linked");
    expect(result.current).toBeNull();
    expect(
      await environment.database.db
        .select()
        .from(account)
        .where(eq(account.providerId, providerId)),
    ).toEqual([]);
    expect(
      await environment.database.db.select().from(member).where(eq(member.userId, existing.id)),
    ).toEqual([]);
  });

  it("leaves an existing invitation for native acceptance instead of replacing its role", async () => {
    const invitationId = crypto.randomUUID();
    await environment.database.db.insert(invitation).values({
      id: invitationId,
      organizationId,
      email: provider.settings.email,
      role: "admin",
      inviterId: environment.owner.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await login();
    expect(result.completed.headers.get("location")).toBe("/apps");
    const userId = z.string().parse(result.current?.user.id);
    expect(
      await environment.database.db.select().from(member).where(eq(member.userId, userId)),
    ).toEqual([]);
    expect(
      await environment.database.db
        .select()
        .from(invitation)
        .where(eq(invitation.id, invitationId)),
    ).toEqual([expect.objectContaining({ status: "pending", role: "admin" })]);
  });

  it("rejects sign-in to an organization that has not been admitted", async () => {
    admitted = false;
    const result = await login();
    expect(result.completed.headers.get("location")).toContain("error=ORGANIZATION_UNAVAILABLE");
    expect(result.current).toBeNull();
    expect(
      await environment.database.db
        .select()
        .from(user)
        .where(eq(user.email, provider.settings.email)),
    ).toEqual([]);
    expect(
      await environment.database.db
        .select()
        .from(member)
        .where(eq(member.organizationId, organizationId)),
    ).toEqual([]);
  });
});
