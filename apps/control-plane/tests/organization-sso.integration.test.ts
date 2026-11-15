import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { decodeJwt } from "jose";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { createTestEnvironment } from "./environment.ts";
import { createIdentityProvider } from "./edge/auth-proxy-idp.ts";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { apiResource, cliClientId } from "../src/lib/server/auth-options.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import {
  invitation,
  member,
  organization,
  session,
  ssoProvider,
} from "../src/lib/server/auth-schema.ts";
import { organizationRuntimes, organizationSettings } from "../src/lib/server/schema.ts";
import { registerAppLogin, readAppLogin } from "../src/lib/server/app-login-client.ts";
import {
  createInvitationService,
  prepareOrganizationInvitation,
} from "../src/lib/server/members.ts";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

const deviceResponse = z.object({ device_code: z.string(), user_code: z.string() });

const tokenResponse = z.object({ access_token: z.string(), refresh_token: z.string() });

describe("Organization SSO authority across browser and CLI sessions", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let auth: ReturnType<typeof createAuthentication>;
  let identity: ReturnType<typeof createIdentityService>;
  let firstProvider: Awaited<ReturnType<typeof createIdentityProvider>>;
  let secondProvider: Awaited<ReturnType<typeof createIdentityProvider>>;
  let userId: string;
  let firstCookie: string;
  let secondCookie: string;
  const firstOrg = crypto.randomUUID();
  const secondOrg = crypto.randomUUID();
  const origin = "http://localhost:25430";
  const authUrl = `${origin}/api/auth`;

  const request = (
    path: string,
    body?: URLSearchParams | z.infer<ReturnType<typeof z.json>>,
    cookie = "",
  ) => {
    const headers = new Headers({ origin, cookie, accept: "application/json" });

    if (body)
      headers.set(
        "content-type",
        body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json",
      );

    return auth.handler(
      new Request(`${authUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? (body instanceof URLSearchParams ? body : JSON.stringify(body)) : null,
      }),
    );
  };

  const redirect = async (response: Response) => {
    if (response.status === 302 || response.status === 303)
      return z.string().parse(response.headers.get("location"));
    const raw = await response.text();
    expect(raw, `status ${response.status}`).not.toBe("");
    const body: unknown = JSON.parse(raw);
    expect(response.status, JSON.stringify(body)).toBe(200);

    return z.object({ url: z.string() }).parse(body).url;
  };

  const loginCompany = async (providerId: string) => {
    const started = await request("/sign-in/sso", {
      providerId,
      callbackURL: `${origin}/`,
    });

    const target = await redirect(started);
    const authorized = await fetch(target, { redirect: "manual" });
    expect(authorized.status, await authorized.clone().text()).toBe(302);
    const callback = z.string().parse(authorized.headers.get("location"));

    const completed = await auth.handler(
      new Request(callback, { headers: { cookie: cookies(started) } }),
    );

    expect(completed.headers.get("location"), await completed.clone().text()).toBe(`${origin}/`);
    const result = cookies(completed);
    const current = await auth.api.getSession({ headers: new Headers({ cookie: result }) });
    expect(current?.user.id).toBe(userId);

    return { cookie: result, current };
  };

  const start = async () => {
    const response = await request(
      "/device/code",
      new URLSearchParams({
        client_id: cliClientId,
        scope: "openid offline_access platform:read platform:write",
        resource: apiResource(environment.configuration),
      }),
    );

    expect(response.status, await response.clone().text()).toBe(200);

    return deviceResponse.parse(await response.json());
  };

  const consent = async (code: string, cookie: string) => {
    const response = await request(
      `/device?user_code=${encodeURIComponent(code)}`,
      undefined,
      cookie,
    );

    expect(response.status, await response.clone().text()).toBe(200);

    return code;
  };

  const approve = (code: string, cookie: string, accept = true) =>
    request(accept ? "/device/approve" : "/device/deny", { userCode: code }, cookie);

  const confirmed = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
  };

  const poll = (code: string) =>
    request(
      "/oauth2/token",
      new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: cliClientId,
        device_code: code,
      }),
    );

  const refresh = (token: string) =>
    request(
      "/oauth2/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cliClientId,
        refresh_token: token,
      }),
    );

  const access = (token: string, organizationId: string) =>
    identity.authenticate(
      new Request(`${apiResource(environment.configuration)}/me`, {
        headers: { authorization: `Bearer ${token}`, "x-widefleet-organization": organizationId },
      }),
      "platform:read",
    );

  beforeAll(async () => {
    environment = await createTestEnvironment(origin);
    firstProvider = await createIdentityProvider(`${authUrl}/sso/callback/company-alpha`, false);
    secondProvider = await createIdentityProvider(`${authUrl}/sso/callback/company-bravo`, false);

    auth = createAuthentication(environment.configuration, environment.database.db, {
      organizationAccess: {
        filterOrganizations: async (candidates) => candidates.map((candidate) => candidate.id),
      },
    });
    identity = createIdentityService(auth, environment.database.db, environment.configuration, {
      filterOrganizations: async (candidates) => candidates.map((candidate) => candidate.id),
    });
    const user = environment.users.createUser({ email: "user@example.test", emailVerified: true });
    await environment.users.saveUser(user);
    userId = user.id;

    for (const [index, id] of [firstOrg, secondOrg].entries()) {
      await environment.database.db.insert(organization).values({
        id,
        slug: `company-check-${index}`,
        name: `Fixture ${index}`,
        createdAt: new Date(),
      });
      await environment.database.db.insert(organizationRuntimes).values({ organizationId: id });
      await environment.database.db
        .insert(organizationSettings)
        .values({ organizationId: id, settings: {}, ssoRequired: true });
      await environment.database.db.insert(member).values({
        id: crypto.randomUUID(),
        userId,
        organizationId: id,
        role: "owner",
        createdAt: new Date(),
      });
      const provider = [firstProvider, secondProvider][index];

      if (!provider) throw new Error("Missing synthetic provider");
      const { adapter } = await auth.$context;
      await adapter.create({
        model: "ssoProvider",
        data: {
          providerId: index === 0 ? "company-alpha" : "company-bravo",
          organizationId: id,
          issuer: provider.origin,
          domain: "example.test",
          domainVerified: true,
          oidcConfig: JSON.stringify({
            clientId: "app-login",
            clientSecret: "synthetic-client-secret",
            issuer: provider.origin,
            discoveryEndpoint: `${provider.origin}/.well-known/openid-configuration`,
            pkce: true,
            scopes: ["openid", "profile", "email"],
            mapping: { email: "mail", name: "display_name" },
          }),
        },
      });
    }

    const first = await loginCompany("company-alpha");
    firstCookie = first.cookie;
    expect(first.current?.session.identityOrganizationId).toBe(firstOrg);
    const second = await loginCompany("company-bravo");
    secondCookie = second.cookie;
    expect(second.current?.session.identityOrganizationId).toBe(secondOrg);
  });

  afterAll(async () => {
    await firstProvider?.stop();
    await secondProvider?.stop();
    await environment?.close();
  });

  it("preserves the authenticating organization through approval, another login, and refresh", async () => {
    const device = await start();
    const query = await consent(device.user_code, firstCookie);
    await confirmed(await approve(query, firstCookie));
    // A concurrent login must never redefine the already approved grant.
    await loginCompany("company-bravo");
    const issued = await poll(device.device_code);
    expect(issued.status, await issued.clone().text()).toBe(200);
    const tokens = tokenResponse.parse(await issued.json());
    expect(decodeJwt(tokens.access_token)["reference_id"]).toBe(`organization:${firstOrg}`);
    expect((await access(tokens.access_token, firstOrg)).isOk()).toBe(true);
    expect(await access(tokens.access_token, secondOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    const renewed = await refresh(tokens.refresh_token);
    expect(renewed.status, await renewed.clone().text()).toBe(200);
    const rotated = tokenResponse.parse(await renewed.json());
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(decodeJwt(rotated.access_token)["reference_id"]).toBe(`organization:${firstOrg}`);
    expect((await access(rotated.access_token, firstOrg)).isOk()).toBe(true);
    expect(await access(rotated.access_token, secondOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(
      (
        await identity.organizations(
          new Request(`${apiResource(environment.configuration)}/organizations`, {
            headers: { authorization: `Bearer ${rotated.access_token}` },
          }),
        )
      )
        .unwrap()
        .map((entry) => entry.id),
    ).toEqual([firstOrg]);
  });

  it("issues an independently scoped token for the second company login", async () => {
    const device = await start();
    await confirmed(await approve(await consent(device.user_code, secondCookie), secondCookie));
    const tokens = tokenResponse.parse(await (await poll(device.device_code)).json());
    expect((await access(tokens.access_token, secondOrg)).isOk()).toBe(true);
    expect(await access(tokens.access_token, firstOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("rejects a foreign browser origin without approving the device", async () => {
    const device = await start();
    await consent(device.user_code, firstCookie);

    const foreign = await auth.handler(
      new Request(`${authUrl}/device/approve`, {
        method: "POST",
        headers: {
          origin: "https://foreign.example.test",
          cookie: firstCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ userCode: device.user_code }),
      }),
    );

    expect(foreign.status).toBe(403);
    expect(await (await poll(device.device_code)).json()).toMatchObject({
      error: "authorization_pending",
    });
  });

  it("derives authority from the approving session instead of request fields", async () => {
    const device = await start();
    await consent(device.user_code, firstCookie);
    await confirmed(
      await request(
        "/device/approve",
        {
          userCode: device.user_code,
          referenceId: `user:${userId}`,
          organizationId: secondOrg,
          sessionId: "forged-session",
          authTime: new Date(0).toISOString(),
        },
        firstCookie,
      ),
    );
    const tokens = tokenResponse.parse(await (await poll(device.device_code)).json());
    expect(decodeJwt(tokens.access_token)["reference_id"]).toBe(`organization:${firstOrg}`);
    expect(await access(tokens.access_token, secondOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("keeps the CLI authority after its approving browser session ends", async () => {
    const company = await loginCompany("company-alpha");
    const device = await start();
    await confirmed(await approve(await consent(device.user_code, company.cookie), company.cookie));
    const tokens = tokenResponse.parse(await (await poll(device.device_code)).json());
    await environment.database.db
      .delete(session)
      .where(eq(session.id, z.string().parse(company.current?.session.id)));
    const rotated = tokenResponse.parse(await (await refresh(tokens.refresh_token)).json());
    expect((await access(rotated.access_token, firstOrg)).isOk()).toBe(true);
    expect(await access(rotated.access_token, secondOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("uses the same company boundary for browser selection and organization discovery", async () => {
    const headers = { cookie: firstCookie, origin, "x-widefleet-organization": secondOrg };

    const request = new Request(`${apiResource(environment.configuration)}/organizations`, {
      headers,
    });

    expect((await identity.organizations(request)).unwrap().map((entry) => entry.id)).toEqual([
      firstOrg,
    ]);
    expect(await identity.authenticate(request, "platform:read")).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(await identity.selectOrganization(request, secondOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect((await identity.selectOrganization(request, firstOrg)).isOk()).toBe(true);
  });

  it.each(["/link-social", "/unlink-account", "/get-access-token", "/refresh-token"])(
    "does not let one company session manage another company's linked account: %s",
    async (path) => {
      const response = await request(
        path,
        { provider: "company-bravo", providerId: "company-bravo" },
        firstCookie,
      );

      expect(response.status, await response.clone().text()).toBe(403);
    },
  );

  it.each(["/list-accounts", "/list-sessions", "/revoke-sessions", "/update-user"])(
    "requires independent sign-in for global account management: %s",
    async (path) => {
      const body = path.startsWith("/list-") ? undefined : { name: "Changed by company" };
      const response = await request(path, body, firstCookie);
      expect(response.status, await response.clone().text()).toBe(403);
    },
  );

  it("preserves rejection and blocks replay of a consumed device code", async () => {
    const denied = await start();
    await confirmed(
      await approve(await consent(denied.user_code, firstCookie), firstCookie, false),
    );
    expect(await (await poll(denied.device_code)).json()).toMatchObject({ error: "access_denied" });
    const approved = await start();
    await confirmed(await approve(await consent(approved.user_code, firstCookie), firstCookie));
    expect((await poll(approved.device_code)).status).toBe(200);
    expect((await poll(approved.device_code)).status).toBeGreaterThanOrEqual(400);
  });

  it("blocks recovery sessions from approving CLI credentials", async () => {
    const recovery = await environment.users.login({ userId });
    await environment.database.db
      .update(session)
      .set({ recovery: true })
      .where(eq(session.token, recovery.token));
    const cookie = new Headers(recovery.headers).get("cookie") ?? "";
    const device = await start();
    const result = await approve(await consent(device.user_code, cookie), cookie);
    expect(result.status).toBe(403);
    expect(await (await poll(device.device_code)).json()).toMatchObject({
      error: "authorization_pending",
    });
  });

  it("requires company SSO even when global email login has an existing membership", async () => {
    const global = await environment.users.login({ userId });
    const cookie = new Headers(global.headers).get("cookie") ?? "";
    const device = await start();
    await confirmed(await approve(await consent(device.user_code, cookie), cookie));
    const tokens = tokenResponse.parse(await (await poll(device.device_code)).json());
    expect(decodeJwt(tokens.access_token)["reference_id"]).toBe(`user:${userId}`);
    expect(await access(tokens.access_token, firstOrg)).toMatchObject({
      error: { code: "SSO_REQUIRED" },
    });
    expect(await access(tokens.access_token, secondOrg)).toMatchObject({
      error: { code: "SSO_REQUIRED" },
    });
  });

  it("does not accept tokens without an authentication reference", async () => {
    const now = Math.floor(Date.now() / 1000);

    const { token } = await auth.api.signJWT({
      body: {
        payload: {
          sub: userId,
          aud: apiResource(environment.configuration),
          iss: authUrl,
          iat: now,
          exp: now + 300,
          scope: "platform:read",
        },
      },
    });

    expect(await access(token, firstOrg)).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("uses the session at final approval when it changes after opening consent", async () => {
    const device = await start();
    const query = await consent(device.user_code, firstCookie);
    const changed = await approve(query, secondCookie);
    await confirmed(changed);
    const tokens = tokenResponse.parse(await (await poll(device.device_code)).json());
    expect(decodeJwt(tokens.access_token)["reference_id"]).toBe(`organization:${secondOrg}`);
    expect((await access(tokens.access_token, secondOrg)).isOk()).toBe(true);
    expect(await access(tokens.access_token, firstOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it.each(["approve", "deny"])(
    "rejects a stale browser page when attempting to %s",
    async (decision) => {
      const device = await start();
      await consent(device.user_code, firstCookie);
      const original = await auth.api.getSession({ headers: new Headers({ cookie: firstCookie }) });

      const response = await auth.handler(
        new Request(`${authUrl}/device/${decision}`, {
          method: "POST",
          headers: {
            origin,
            cookie: secondCookie,
            "content-type": "application/json",
            "x-widefleet-approval-session": z.string().parse(original?.session.id),
          },
          body: JSON.stringify({ userCode: device.user_code }),
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "access_denied",
        error_description: "Your sign-in changed. Reload this page before connecting the CLI.",
      });
      expect(await (await poll(device.device_code)).json()).toMatchObject({
        error: "authorization_pending",
      });
    },
  );

  it.each(["missing-expiry", "missing-issued-at"])(
    "rejects company ID tokens with missing required timestamps: %s",
    async (failure) => {
      firstProvider.settings.failure = failure;

      try {
        const started = await request("/sign-in/sso", {
          providerId: "company-alpha",
          callbackURL: `${origin}/`,
        });

        const authorized = await fetch(await redirect(started), { redirect: "manual" });
        const callback = z.string().parse(authorized.headers.get("location"));

        const completed = await auth.handler(
          new Request(callback, { headers: { cookie: cookies(started) } }),
        );

        expect(completed.headers.get("location")).toContain("error=");
        expect(
          await auth.api.getSession({ headers: new Headers({ cookie: cookies(completed) }) }),
        ).toBeNull();
      } finally {
        firstProvider.settings.failure = "";
      }
    },
  );

  it("does not let a company login accept an invitation to another organization", async () => {
    const organizationId = crypto.randomUUID();

    const prepared = await environment.database.db.transaction(async (transaction) => {
      await transaction.insert(organization).values({
        id: organizationId,
        slug: "invitation-destination",
        name: "Invitation destination",
        createdAt: new Date(),
      });
      await transaction.insert(organizationRuntimes).values({ organizationId });

      return prepareOrganizationInvitation(transaction, organizationId, environment.owner.id, {
        email: "user@example.test",
        role: "owner",
      });
    });

    const invitations = createInvitationService(
      environment.database.db,
      environment.configuration,
      undefined,
      {
        filterOrganizations: async (candidates) => candidates.map((candidate) => candidate.id),
      },
    );

    const scoped = (
      await identity.authenticateUser(
        new Request(`${origin}/invitations/${prepared.invitation.id}`, {
          headers: { cookie: firstCookie },
        }),
        "platform:read",
      )
    ).unwrap();

    await expect(invitations.read(scoped, prepared.invitation.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      invitations.accept(prepared.invitation.id, {
        auth,
        headers: new Headers({ cookie: firstCookie }),
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      invitations.accept(prepared.invitation.id, {
        auth,
        headers: (await environment.users.login({ userId })).headers,
      }),
    ).resolves.toEqual({ organizationId });
  });

  it("routes only pending invitations to an admitted, verified company login", async () => {
    const organizationId = crypto.randomUUID();
    await environment.database.db.insert(organization).values({
      id: organizationId,
      slug: "invitation-routing",
      name: "Routing fixture",
      createdAt: new Date(),
    });

    const prepared = await environment.database.db.transaction((transaction) =>
      prepareOrganizationInvitation(transaction, organizationId, environment.owner.id, {
        email: "invited@example.test",
        role: "member",
      }),
    );

    let admitted = true;

    const invitations = createInvitationService(
      environment.database.db,
      environment.configuration,
      undefined,
      {
        filterOrganizations: async (candidates) => (admitted ? candidates.map(({ id }) => id) : []),
      },
    );

    const id = prepared.invitation.id;
    expect(await invitations.companySignIn(id)).toBeNull();
    await environment.database.db.insert(ssoProvider).values({
      id: crypto.randomUUID(),
      providerId: "invitation-routing",
      organizationId,
      issuer: firstProvider.origin,
      domain: "example.test",
      domainVerified: false,
    });
    expect(await invitations.companySignIn(id)).toBeNull();
    await environment.database.db
      .update(ssoProvider)
      .set({ domainVerified: true })
      .where(eq(ssoProvider.organizationId, organizationId));
    expect(await invitations.companySignIn(id)).toBeNull();
    await environment.database.db
      .insert(organizationSettings)
      .values({ organizationId, settings: {}, ssoRequired: true });
    expect(await invitations.companySignIn(id)).toEqual({
      id: organizationId,
      slug: "invitation-routing",
    });
    admitted = false;
    expect(await invitations.companySignIn(id)).toBeNull();
    admitted = true;

    for (const status of ["canceled", "accepted", "rejected"]) {
      await environment.database.db.update(invitation).set({ status }).where(eq(invitation.id, id));
      expect(await invitations.companySignIn(id)).toBeNull();
    }

    await environment.database.db
      .update(invitation)
      .set({ status: "pending", expiresAt: new Date(0) })
      .where(eq(invitation.id, id));
    expect(await invitations.companySignIn(id)).toBeNull();
    expect(await invitations.companySignIn(crypto.randomUUID())).toBeNull();
  });

  it("does not expose Widefleet app sign-in when company SSO is active", async () => {
    await environment.database.db.transaction((transaction) =>
      registerAppLogin(
        transaction,
        environment.configuration,
        environment.environment.PLATFORM_ENCRYPTION_KEY,
        secondOrg,
      ),
    );

    const client = await readAppLogin(
      environment.database.db,
      environment.configuration,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      secondOrg,
    );

    if (!client) throw new Error("Expected an app sign-in client");
    const secret = client.management.clientSecret;
    const callback = `https://auth.${environment.configuration.APP_DOMAIN}/oauth2/${secondOrg}/callback`;

    const exchange = async (cookie: string) => {
      const verifier = randomBytes(32).toString("base64url");

      const parameters = new URLSearchParams({
        client_id: client.management.clientId,
        response_type: "code",
        redirect_uri: callback,
        scope: "openid profile email",
        state: crypto.randomUUID(),
        nonce: crypto.randomUUID(),
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      });

      const authorized = await request(`/oauth2/authorize?${parameters}`, undefined, cookie);
      const destination = new URL(await redirect(authorized));

      return request(
        "/oauth2/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.management.clientId,
          client_secret: secret,
          code: z.string().parse(destination.searchParams.get("code")),
          redirect_uri: callback,
          code_verifier: verifier,
        }),
      );
    };

    const denied = await exchange(firstCookie);
    expect(denied.status, await denied.clone().text()).toBeGreaterThanOrEqual(400);
    const ownCompany = await exchange(secondCookie);
    expect(ownCompany.status).toBe(403);
  });

  it("renews built-in app login, tolerates duplicate refreshes and rechecks membership", async () => {
    const organizationId = crypto.randomUUID();
    await environment.database.db.insert(organization).values({
      id: organizationId,
      slug: `refresh-${organizationId}`,
      name: "Refresh fixture",
      createdAt: new Date(),
    });
    await environment.database.db
      .insert(organizationSettings)
      .values({ organizationId, settings: {} });
    await environment.database.db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    });
    await environment.database.db.transaction((transaction) =>
      registerAppLogin(
        transaction,
        environment.configuration,
        environment.environment.PLATFORM_ENCRYPTION_KEY,
        organizationId,
      ),
    );

    const client = await readAppLogin(
      environment.database.db,
      environment.configuration,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      organizationId,
    );

    if (!client) throw new Error("Expected an app client");
    const global = await environment.users.login({ userId });
    const cookie = new Headers(global.headers).get("cookie") ?? "";
    const verifier = randomBytes(32).toString("base64url");
    const callback = `https://auth.${environment.configuration.APP_DOMAIN}/oauth2/${organizationId}/callback`;

    const parameters = new URLSearchParams({
      client_id: client.management.clientId,
      response_type: "code",
      redirect_uri: callback,
      scope: "openid profile email offline_access",
      state: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });

    const target = new URL(
      await redirect(await request(`/oauth2/authorize?${parameters}`, undefined, cookie)),
    );

    const issued = await request(
      "/oauth2/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.management.clientId,
        client_secret: client.management.clientSecret,
        code: z.string().parse(target.searchParams.get("code")),
        redirect_uri: callback,
        code_verifier: verifier,
      }),
    );

    expect(issued.status, await issued.clone().text()).toBe(200);
    const grant = tokenResponse.parse(await issued.json());

    const renew = (refreshToken: string) =>
      request(
        "/oauth2/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.management.clientId,
          client_secret: client.management.clientSecret,
          refresh_token: refreshToken,
        }),
      );

    const renewed = await renew(grant.refresh_token);
    expect(renewed.status, await renewed.clone().text()).toBe(200);
    const current = tokenResponse.extend({ id_token: z.string() }).parse(await renewed.json());
    expect(decodeJwt(current.id_token)["organization_id"]).toBe(organizationId);
    expect(current.refresh_token).not.toBe(grant.refresh_token);
    const duplicate = await renew(grant.refresh_token);
    expect(duplicate.status, await duplicate.clone().text()).toBe(200);
    expect(tokenResponse.parse(await duplicate.json()).refresh_token).toBe(current.refresh_token);
    await environment.database.db
      .delete(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)));
    expect((await renew(current.refresh_token)).status).toBe(403);
  });

  it("uses real CLI credentials for plugin operations without creating browser sessions", async () => {
    const device = await start();
    await confirmed(await approve(await consent(device.user_code, firstCookie), firstCookie));
    const tokens = tokenResponse.parse(await (await poll(device.device_code)).json());

    const headers = new Headers({
      authorization: `Bearer ${tokens.access_token}`,
      "x-widefleet-organization": firstOrg,
    });

    const sessionsBefore = await environment.database.db.select({ id: session.id }).from(session);

    const invited = await auth.api.createInvitation({
      headers,
      body: { organizationId: firstOrg, email: "cli-plugin@example.test", role: "member" },
    });

    expect(invited.organizationId).toBe(firstOrg);
    await auth.api.cancelInvitation({ headers, body: { invitationId: invited.id } });
    await expect(
      auth.api.createInvitation({
        headers,
        body: { organizationId: secondOrg, email: "foreign-plugin@example.test", role: "owner" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      auth.api.requestDomainVerification({ headers, body: { providerId: "company-bravo" } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await environment.database.db.select({ id: session.id }).from(session)).toEqual(
      sessionsBefore,
    );

    const direct = await auth.handler(
      new Request(`${authUrl}/organization/invite-member`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          organizationId: firstOrg,
          email: "bypass@example.test",
          role: "owner",
        }),
      }),
    );

    expect(direct.status).toBe(404);
  });

  it("checks current membership even for a previously issued scoped token", async () => {
    const device = await start();
    await confirmed(await approve(await consent(device.user_code, firstCookie), firstCookie));
    const tokens = tokenResponse.parse(await (await poll(device.device_code)).json());
    // The last-owner trigger requires a second owner before removing this fixture.
    await environment.database.db.insert(member).values({
      id: crypto.randomUUID(),
      userId: environment.owner.id,
      organizationId: firstOrg,
      role: "owner",
      createdAt: new Date(),
    });
    await environment.database.db
      .delete(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, firstOrg)));
    expect(await access(tokens.access_token, firstOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    const rotated = tokenResponse.parse(await (await refresh(tokens.refresh_token)).json());
    expect(await access(rotated.access_token, firstOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(await access(rotated.access_token, secondOrg)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });
});
