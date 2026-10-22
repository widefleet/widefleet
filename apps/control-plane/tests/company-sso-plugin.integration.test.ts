import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { z } from "zod";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { createTestEnvironment, organizationCredential } from "./environment.ts";
import { editableSettings } from "./settings-input.ts";
import { createIdentityProvider } from "./edge/auth-proxy-idp.ts";
import { organizationSettings } from "../src/lib/server/schema.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { companySsoOrigins } from "../src/lib/server/company-sso.ts";
import { encryptSecret } from "../src/lib/server/secret-encryption.ts";

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

  it("publishes updated app claims after re-verifying an activated connection", async () => {
    const principal = {
      ...environment.owner,
      role: "owner" as const,
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    };

    const credential = await organizationCredential(environment, principal);
    const next = editableSettings(await environment.settings.read(principal));

    if (!next.sso) throw new Error("Missing fixture provider");
    next.sso.domain = "changed.example.test";
    next.sso.oidcConfig.mapping.extraFields.groups = "roles";
    await environment.settings.update(
      principal,
      { ...next, acknowledgeRestart: false },
      false,
      credential,
    );
    expect(environment.authControl.read().configuration?.provider).toMatchObject({
      groupsClaim: "groups",
    });

    const proof = await environment.settings.domainVerification(
      principal,
      credential.auth,
      credential.headers,
    );

    resolver.mockResolvedValue([[proof.value]]);
    await environment.settings.verifyDomain(principal, credential.auth, credential.headers);
    expect((await environment.settings.read(principal)).ssoRequired).toBe(true);
    expect(environment.authControl.read().configuration?.provider).toMatchObject({
      groupsClaim: "roles",
    });
  });

  it("discovers separate endpoint origins for registration and migrated-provider sign-in", async () => {
    await environment.database.db.delete(ssoProvider);
    await environment.database.db.update(organizationSettings).set({ ssoRequired: false });
    const issuer = "https://issuer.example.test";

    const metadata = {
      issuer,
      authorization_endpoint: "https://login.example.test/authorize",
      token_endpoint: "https://tokens.example.test/token",
      jwks_uri: "https://keys.example.test/jwks",
      userinfo_endpoint: "https://profile.example.test/userinfo",
    };

    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(metadata));

    const ipv4 = vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"]);

    const ipv6 = vi.spyOn(dns, "resolve6").mockResolvedValue([]);

    try {
      const logged = await environment.users.login({ userId: environment.owner.id });
      logged.headers.set("origin", origin);

      const input = {
        providerId: "split-origin-provider",
        issuer,
        domain: "example.test",
        organizationId: "widefleet",
        oidcConfig: {
          clientId: "synthetic-client",
          clientSecret: "synthetic-client-secret",
          pkce: true,
          scopes: ["openid", "profile", "email"],
        },
      };

      await expect(environment.auth.api.registerSSOProvider({ body: input })).rejects.toBeDefined();
      expect(request).not.toHaveBeenCalled();
      await environment.auth.api.registerSSOProvider({ headers: logged.headers, body: input });

      // Migrated providers lack hydrated endpoints. Exercise runtime discovery
      // rather than relying only on registration's stored endpoint URLs.
      await environment.database.db.update(ssoProvider).set({
        domainVerified: true,
        oidcConfig: await encryptSecret(
          environment.configuration.PLATFORM_ENCRYPTION_KEY ??
            environment.configuration.BETTER_AUTH_SECRET,
          JSON.stringify({ ...input.oidcConfig, issuer }),
        ),
      });

      const signIn = new Request(`${origin}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ providerId: input.providerId, callbackURL: "/settings" }),
      });

      const response = await environment.auth.handler(signIn);
      const body: unknown = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      const target = z.object({ url: z.url(), redirect: z.literal(true) }).parse(body);
      expect(new URL(target.url).origin).toBe("https://login.example.test");

      const callback = `${origin}/api/auth/sso/callback/${input.providerId}`;

      const trusted = await companySsoOrigins(
        environment.database.db,
        origin,
        new Request(callback),
      );

      expect(trusted).toContain("https://tokens.example.test");
      expect(trusted).toContain("https://profile.example.test");
      request.mockClear();
      ipv4.mockClear();
      expect(await companySsoOrigins(environment.database.db, origin)).toEqual([origin]);
      expect(
        await companySsoOrigins(
          environment.database.db,
          origin,
          new Request(`${origin}/api/auth/sign-out`),
        ),
      ).toEqual([origin]);
      expect(
        await companySsoOrigins(
          environment.database.db,
          origin,
          new Request(callback, { headers: { origin: "https://tokens.example.test" } }),
        ),
      ).toEqual([origin]);
      expect(
        await companySsoOrigins(
          environment.database.db,
          origin,
          new Request(`${origin}/api/auth/sso/callback/missing`),
        ),
      ).toEqual([origin]);
      await environment.database.db.update(ssoProvider).set({ domainVerified: false });
      expect(
        await companySsoOrigins(environment.database.db, origin, new Request(callback)),
      ).toEqual([origin]);
      expect(request).not.toHaveBeenCalled();
      expect(ipv4).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      ipv4.mockRestore();
      ipv6.mockRestore();
    }
  });
});
