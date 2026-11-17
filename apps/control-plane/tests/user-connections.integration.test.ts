import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { companyOAuth } from "@platform/auth-proxy/company-oauth";
import { authConfiguration } from "@platform/auth-proxy/configuration";
import { userConnectionInvocation } from "@platform/contracts";
import { createTestEnvironment } from "./environment.ts";
import { createIdentityProvider, objectId, tenantId } from "./edge/auth-proxy-idp.ts";
import { createAppUserIdentity } from "../src/lib/server/app-user-identity.ts";
import { createUserConnections } from "../src/lib/server/user-connections.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { registerAppLogin } from "../src/lib/server/app-login-client.ts";
import { account, ssoProvider } from "../src/lib/server/auth-schema.ts";
import { apps, artifacts, deployments, organizationSettings } from "../src/lib/server/schema.ts";
import { encryptSecret } from "../src/lib/server/secret-encryption.ts";

const disconnected = { setup: "ready", connection: "disconnected", account: null };

describe("Personal connector accounts", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let identify: ReturnType<typeof createAppUserIdentity>;
  const calls: z.infer<typeof userConnectionInvocation>[] = [];
  let status = 200;

  const principal = () => ({
    id: environment.owner.id,
    name: "Member",
    email: "owner@example.test",
    admin: false,
    creator: true,
    role: "member" as const,
    application: environment.application,
  });

  const service = () =>
    createUserConnections(
      environment.database.db,
      environment.configuration,
      identify,
      async (input) => {
        calls.push(input);

        if (status !== 200) return new Response(null, { status });

        switch (input.operation.action) {
          case "status":
            return Response.json(disconnected);
          case "prepare":
            return Response.json({
              url: `https://${input.hostname}/connect/start?ticket=synthetic`,
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
            });
          case "disconnect":
            return Response.json({ disconnected: true });
        }
      },
    );

  const deploy = async (slug: string, entrypoints = ["UserConnection"], listed = true) => {
    const app = (
      await createAppService(environment.database.db, environment.configuration).create(
        principal(),
        { slug, displayName: slug, parentId: null },
      )
    ).unwrap();

    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();
    await environment.database.db.insert(artifacts).values({
      id: artifactId,
      appId: app.id,
      metadata: { entrypoints },
      manifest: {},
      modules: [],
    });
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId: app.id,
      artifactId,
      status: "succeeded",
      requestId: crypto.randomUUID(),
    });
    await environment.database.db
      .update(apps)
      .set({ state: "active", activeDeploymentId: deploymentId, catalogListed: listed })
      .where(eq(apps.id, app.id));

    return app;
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();
    identify = createAppUserIdentity(
      environment.database.db,
      environment.configuration,
      environment.settings,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
    );
    await registerAppLogin(
      environment.database.db,
      environment.configuration,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      "widefleet",
    );
  });
  beforeEach(async () => {
    await environment.database.db.delete(apps);
    await environment.database.db.update(organizationSettings).set({ ssoRequired: false });
    calls.length = 0;
    status = 200;
  });
  afterAll(async () => {
    await environment.close();
  });

  it("lets ordinary members manage only published opt-in connectors under their app identity", async () => {
    const visible = await deploy("visible");
    await deploy("ordinary", ["default"]);
    const hidden = await deploy("hidden", ["UserConnection"], false);
    expect(await service().list(principal())).toEqual([
      {
        appId: visible.id,
        displayName: "visible",
        hostname: visible.hostname,
        status: disconnected,
        unavailable: false,
      },
    ]);
    expect(calls[0]?.identity).toEqual({
      issuer: `${environment.configuration.PLATFORM_URL}/api/auth`,
      subject: environment.owner.id,
      name: "Member",
      groups: [],
    });
    const prepared = await service().prepare(principal(), visible.id, true);
    expect(new URL(prepared.url).hostname).toBe(visible.hostname);
    expect(calls.at(-1)?.operation).toEqual({
      action: "prepare",
      completionUrl: `${environment.configuration.PLATFORM_URL}/connections?completed=${visible.id}&onboarding=1`,
    });
    await expect(service().prepare(principal(), hidden.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await service().disconnect(principal(), visible.id)).toEqual({ disconnected: true });
    const count = calls.length;
    await expect(
      service().disconnect(
        { ...principal(), application: { organizationId: "another-org", admin: true } },
        visible.id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toHaveLength(count);
  });

  it("omits inaccessible connectors and distinguishes outages from disconnected accounts", async () => {
    const app = await deploy("visible");
    status = 404;
    expect(await service().list(principal())).toEqual([]);
    status = 503;
    expect(await service().list(principal())).toEqual([
      {
        appId: app.id,
        displayName: "visible",
        hostname: app.hostname,
        status: null,
        unavailable: true,
      },
    ]);
    await expect(service().disconnect(principal(), app.id)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("authenticates the public API and rejects caller or return-URL overrides", async () => {
    const app = await deploy("api-visible");

    const user = environment.users.createUser({
      name: "Connector member",
      email: "connector-member@example.test",
    });

    await environment.users.saveUser(user);
    await environment.linkMicrosoftUser(user.id);
    const session = await environment.users.login({ userId: user.id });

    const runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      reporting: environment.reporting,
      storage: createStorage(environment.configuration),
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
    })();

    const api = createApi({ ...runtime, userConnections: service() });

    const request = (path: string, method = "GET", body?: Record<string, string>) => {
      const headers = new Headers(session.headers);
      headers.set("origin", environment.configuration.PLATFORM_URL);
      headers.set("content-type", "application/json");

      const options: RequestInit = { method, headers };

      if (body) options.body = JSON.stringify(body);

      return new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, options);
    };

    const path = `/user-connections/${app.id}`;
    expect((await api(request("/user-connections"))).status).toBe(200);
    expect(calls.at(-1)?.identity.subject).toBe(user.id);
    const connected = await api(request(`${path}/connect`, "POST", {}));
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({
      url: `https://${app.hostname}/connect/start?ticket=synthetic`,
    });
    expect((await api(request(path, "DELETE"))).status).toBe(200);
    const count = calls.length;
    expect(
      (
        await api(
          request(`${path}/connect`, "POST", {
            subject: environment.owner.id,
            completionUrl: "https://attacker.example.test",
          }),
        )
      ).status,
    ).toBe(400);
    const crossOrigin = request(path, "DELETE");
    crossOrigin.headers.set("origin", "https://attacker.example.test");
    expect((await api(crossOrigin)).status).toBe(403);
    const crossOrganization = request(path, "DELETE");
    crossOrganization.headers.set("X-Widefleet-Organization", "another-org");
    expect((await api(crossOrganization)).status).toBe(403);
    expect(
      (
        await api(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, {
            method: "DELETE",
            headers: { origin: environment.configuration.PLATFORM_URL },
          }),
        )
      ).status,
    ).toBe(401);
    expect(calls).toHaveLength(count);
  });

  it("preserves Entra oid identity and serializes refresh while keeping a rotated token after a directory outage", async () => {
    const idp = await createIdentityProvider();
    idp.settings.entra = true;
    idp.settings.groups = [crypto.randomUUID()];
    idp.settings.rotateRefreshTokens = true;
    const originalFetch = globalThis.fetch;

    const network = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const request = new Request(input, init);

      if (new URL(request.url).origin === "https://graph.microsoft.com")
        return originalFetch(
          new URL(new URL(request.url).pathname + new URL(request.url).search, idp.origin),
          init,
        );

      return originalFetch(input, init);
    });

    try {
      const configuration = authConfiguration.parse({
        organizationId: "widefleet",
        provider: { type: "entra", authority: idp.origin, tenantId, label: "Microsoft" },
        clientId: "app-login",
        clientSecret: "synthetic-client-secret",
        cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
        domain: "apps.localhost",
        redirectUrl: "https://auth.apps.localhost/oauth2/widefleet/callback",
      });

      const oauth = await companyOAuth({
        ...configuration,
        redirectUrl: "https://auth.apps.example.test/oauth2/widefleet/callback",
      });

      const verifier = crypto.randomUUID() + crypto.randomUUID();

      const authorized = await fetch(await oauth.authorize("state", verifier, "nonce"), {
        redirect: "manual",
      });

      const code =
        new URL(z.string().parse(authorized.headers.get("location"))).searchParams.get("code") ??
        "";

      const tokens = z
        .object({ id_token: z.string(), access_token: z.string(), refresh_token: z.string() })
        .parse(
          await (
            await fetch(`${idp.origin}/token`, {
              method: "POST",
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                code_verifier: verifier,
                redirect_uri: "https://auth.apps.example.test/oauth2/widefleet/callback",
                client_id: "app-login",
                client_secret: "synthetic-client-secret",
              }),
            })
          ).json(),
        );

      await environment.database.db.update(ssoProvider).set({
        issuer: `${idp.origin}/${tenantId}/v2.0`,
        appIdentityType: "entra",
        domainVerified: true,
        oidcConfig: await encryptSecret(
          environment.environment.PLATFORM_ENCRYPTION_KEY,
          JSON.stringify({
            clientId: "app-login",
            clientSecret: "synthetic-client-secret",
            pkce: true,
            scopes: ["openid", "profile", "email", "User.Read"],
            mapping: { name: "name", email: "email", extraFields: { groups: "groups" } },
          }),
        ),
      });
      await environment.database.db.update(organizationSettings).set({ ssoRequired: true });

      const row = {
        id: crypto.randomUUID(),
        userId: environment.owner.id,
        providerId: "microsoft",
        accountId: "pairwise-subject",
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: new Date(Date.now() - 1),
      };

      await environment.database.db
        .delete(account)
        .where(and(eq(account.userId, row.userId), eq(account.providerId, row.providerId)));
      await environment.database.db.insert(account).values(row);
      const results = await Promise.all([identify(principal()), identify(principal())]);

      for (const result of results)
        expect(result.identity).toEqual({
          issuer: `${idp.origin}/${tenantId}/v2.0`,
          subject: objectId,
          name: "Example User",
          groups: idp.settings.groups,
        });
      expect(idp.refreshRequests).toHaveLength(1);

      const [saved] = await environment.database.db
        .select()
        .from(account)
        .where(eq(account.id, row.id));

      expect(saved?.refreshToken).not.toBe(tokens.refresh_token);
      await environment.database.db
        .update(account)
        .set({ accessTokenExpiresAt: new Date(Date.now() - 1) })
        .where(eq(account.id, row.id));
      idp.settings.graphFailure = "unavailable";
      await expect(identify(principal())).rejects.toMatchObject({ statusCode: 503 });

      const [rotated] = await environment.database.db
        .select()
        .from(account)
        .where(eq(account.id, row.id));

      expect(rotated?.refreshToken).not.toBe(saved?.refreshToken);
      idp.settings.graphFailure = "";
      expect((await identify(principal())).identity.subject).toBe(objectId);
      await environment.database.db
        .update(account)
        .set({ accessTokenExpiresAt: new Date(Date.now() - 1) })
        .where(eq(account.id, row.id));
      idp.settings.refreshFailure = "invalid_grant";
      await expect(identify(principal())).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      network.mockRestore();
      await idp.stop();
    }
  });
});
