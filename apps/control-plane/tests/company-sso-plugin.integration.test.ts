import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { z } from "zod";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { createTestEnvironment } from "./environment.ts";
import { createIdentityProvider } from "./edge/auth-proxy-idp.ts";
import { organizationSettings } from "../src/lib/server/schema.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";

describe("Better Auth SSO provider integration", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let idp: Awaited<ReturnType<typeof createIdentityProvider>>;
  const origin = "http://localhost:25430";
  const resolver = vi.spyOn(dns, "resolveTxt");

  beforeAll(async () => {
    syncBuiltinESMExports();
    environment = await createTestEnvironment(origin);
    idp = await createIdentityProvider(`${origin}/api/auth/sso/callback/test-company`);
  });
  afterAll(async () => {
    resolver.mockRestore();
    syncBuiltinESMExports();
    await idp.stop();
    await environment.close();
  });

  it("encrypts provider credentials and verifies the domain through the plugin", async () => {
    await environment.database.db.delete(ssoProvider);
    await environment.database.db.update(organizationSettings).set({
      ssoRequired: false,
      settings: {
        appIdentity: { type: "oidc", groupsClaim: "groups" },
        directory: null,
        externallyManaged: false,
      },
    });

    const auth = betterAuth({
      ...environment.auth.options,
      trustedOrigins: [origin, idp.origin],
    });

    const logged = await environment.users.login({ userId: environment.owner.id });
    const headers = logged.headers;
    headers.set("origin", origin);

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
    );

    const authenticate = () =>
      identity.authenticate(new Request(`${origin}/api/v1/me`, { headers }), "platform:write");

    const principal = (await authenticate()).unwrap();

    const created = await auth.api.registerSSOProvider({
      headers,
      body: {
        providerId: "test-company",
        issuer: idp.origin,
        domain: "example.test",
        organizationId: "widefleet",
        oidcConfig: {
          clientId: "app-login",
          clientSecret: "synthetic-client-secret",
          pkce: true,
          scopes: ["openid", "profile", "email"],
          mapping: { email: "mail", name: "display_name" },
        },
      },
    });

    expect(created.domainVerified).toBe(false);
    await expect(environment.settings.activateSso(principal)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const [stored] = await environment.database.db.select().from(ssoProvider);
    expect(stored?.oidcConfig).not.toContain("synthetic-client-secret");
    expect(() => {
      JSON.parse(stored?.oidcConfig ?? "");
    }).toThrow();
    await expect(
      auth.api.signInSSO({ body: { providerId: "test-company", callbackURL: "/apps" } }),
    ).rejects.toThrow();

    resolver.mockResolvedValue([["wrong-token"]]);
    await expect(
      auth.api.verifyDomain({ headers, body: { providerId: "test-company" } }),
    ).rejects.toThrow();
    resolver.mockResolvedValue([[z.string().parse(created.domainVerificationToken)]]);
    await auth.api.verifyDomain({ headers, body: { providerId: "test-company" } });
    expect(resolver).toHaveBeenLastCalledWith("_better-auth-token-test-company.example.test");

    const [verified] = await environment.database.db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.providerId, "test-company"));

    expect(verified?.domainVerified).toBe(true);

    const redirect = await auth.api.signInSSO({
      body: { providerId: "test-company", callbackURL: "/apps" },
    });

    expect(new URL(redirect.url).origin).toBe(idp.origin);
    expect(redirect.url).not.toContain("synthetic-client-secret");
    expect((await authenticate()).isOk()).toBe(true);
    expect((await environment.settings.read(principal)).ssoRequired).toBe(false);
    // The test redirect was not completed: activation deliberately requires no test-login proof.
    const activated = await environment.settings.activateSso(principal);
    expect(activated.ssoRequired).toBe(true);
    expect(environment.authControl.read().configuration?.clientId).toBe("app-login");
    expect(await authenticate()).toMatchObject({ error: { code: "SSO_REQUIRED" } });
  });
});
