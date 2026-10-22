import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
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
import { decryptSecret, encryptSecret } from "../src/lib/server/secret-encryption.ts";

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

  it.each(["registered", "migrated"])(
    "completes %s-provider sign-in without rediscovering saved endpoints",
    async (kind) => {
      await environment.database.db.delete(ssoProvider);
      await environment.database.db.update(organizationSettings).set({ ssoRequired: false });
      const issuer = "https://issuer.example.test";
      const providerId = `split-origin-${kind}`;

      const encryptionKey =
        environment.configuration.PLATFORM_ENCRYPTION_KEY ??
        environment.configuration.BETTER_AUTH_SECRET;

      let discoveryAvailable = true;

      const metadata = {
        issuer,
        authorization_endpoint: "https://login.example.test/authorize",
        token_endpoint: "https://tokens.example.test/token",
        jwks_uri: "https://keys.example.test/jwks",
        userinfo_endpoint: "https://profile.example.test/userinfo",
      };

      const keys = await generateKeyPair("RS256", { extractable: true });
      const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "split-origin", alg: "RS256" };

      const profile = {
        sub: `split-origin-${kind}`,
        email: `split-origin-${kind}@example.test`,
        name: "Split Origin User",
        email_verified: true,
      };

      const idToken = await new SignJWT(profile)
        .setProtectedHeader({ alg: "RS256", kid: publicKey.kid })
        .setIssuer(issuer)
        .setAudience("synthetic-client")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);

      const visited = new Set<string>();

      const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const outgoing = new Request(input, init);
        visited.add(outgoing.url);

        switch (outgoing.url) {
          case `${issuer}/.well-known/openid-configuration`:
            if (!discoveryAvailable) return new Response(null, { status: 503 });

            return Response.json(metadata);
          case metadata.token_endpoint: {
            expect(outgoing.method).toBe("POST");
            const fields = new URLSearchParams(await outgoing.text());
            expect(fields.get("code")).toBe("synthetic-code");
            expect(fields.get("redirect_uri")).toBe(
              `${origin}/api/auth/sso/callback/${providerId}`,
            );

            return Response.json({
              access_token: "synthetic-access-token",
              token_type: "Bearer",
              expires_in: 300,
              id_token: idToken,
            });
          }

          case metadata.jwks_uri:
            return Response.json({ keys: [publicKey] });

          case metadata.userinfo_endpoint:
            expect(outgoing.headers.get("authorization")).toBe("Bearer synthetic-access-token");

            return Response.json(profile);
          default:
            throw new Error(`Unexpected identity-provider request: ${outgoing.url}`);
        }
      });

      const ipv4 = vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"]);

      const ipv6 = vi.spyOn(dns, "resolve6").mockResolvedValue([]);

      try {
        const logged = await environment.users.login({ userId: environment.owner.id });
        logged.headers.set("origin", origin);

        const input = {
          providerId,
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

        await expect(
          environment.auth.api.registerSSOProvider({ body: input }),
        ).rejects.toBeDefined();
        expect(request).not.toHaveBeenCalled();
        await environment.auth.api.registerSSOProvider({ headers: logged.headers, body: input });
        expect(request).toHaveBeenCalledOnce();
        discoveryAvailable = false;
        request.mockClear();
        const rotatedSecret = "concurrently-rotated-secret";

        if (kind === "registered")
          ipv4.mockImplementationOnce(async () => {
            const [current] = await environment.database.db.select().from(ssoProvider);

            const configuration = z
              .record(z.string(), z.unknown())
              .parse(
                JSON.parse(
                  await decryptSecret(encryptionKey, z.string().parse(current?.oidcConfig)),
                ),
              );

            await environment.database.db.update(ssoProvider).set({
              oidcConfig: await encryptSecret(
                encryptionKey,
                JSON.stringify({
                  ...configuration,
                  clientSecret: rotatedSecret,
                }),
              ),
            });

            return ["93.184.216.34"];
          });

        await environment.auth.api.updateSSOProvider({
          headers: logged.headers,
          body: { providerId, oidcConfig: { scopes: ["openid", "email", "profile"] } },
        });
        expect(request).not.toHaveBeenCalled();

        // Migrated providers lack hydrated endpoints. Exercise runtime discovery
        // rather than relying only on registration's stored endpoint URLs.
        await environment.database.db.update(ssoProvider).set({ domainVerified: true });

        if (kind === "migrated")
          await environment.database.db.update(ssoProvider).set({
            oidcConfig: await encryptSecret(
              encryptionKey,
              JSON.stringify({ ...input.oidcConfig, issuer }),
            ),
          });
        request.mockClear();
        discoveryAvailable = kind === "migrated";

        if (kind === "migrated") {
          const [before] = await environment.database.db.select().from(ssoProvider);
          // A callback from an already-started legacy flow must retain the
          // configuration fingerprint recorded in that flow's OAuth state.
          await companySsoOrigins(
            environment.database.db,
            origin,
            encryptionKey,
            new Request(`${origin}/api/auth/sso/callback/${providerId}`),
          );
          const [after] = await environment.database.db.select().from(ssoProvider);
          expect(after?.oidcConfig).toBe(before?.oidcConfig);
          request.mockClear();
        }

        const signIn = new Request(`${origin}/api/auth/sign-in/sso`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ providerId: input.providerId, callbackURL: "/settings" }),
        });

        const response = await environment.auth.handler(signIn.clone());
        const body: unknown = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        const target = z.object({ url: z.url(), redirect: z.literal(true) }).parse(body);
        expect(new URL(target.url).origin).toBe("https://login.example.test");
        expect(request).toHaveBeenCalledTimes(kind === "migrated" ? 1 : 0);

        const [saved] = await environment.database.db.select().from(ssoProvider);
        const encrypted = z.string().parse(saved?.oidcConfig);
        expect(encrypted).not.toContain(input.oidcConfig.clientSecret);
        expect(JSON.parse(await decryptSecret(encryptionKey, encrypted))).toMatchObject({
          tokenEndpoint: metadata.token_endpoint,
          jwksEndpoint: metadata.jwks_uri,
          userInfoEndpoint: metadata.userinfo_endpoint,
          clientSecret: kind === "registered" ? rotatedSecret : input.oidcConfig.clientSecret,
        });
        discoveryAvailable = false;
        visited.clear();

        const callback = `${origin}/api/auth/sso/callback/${input.providerId}`;
        const callbackUrl = new URL(callback);
        callbackUrl.searchParams.set(
          "state",
          z.string().min(1).parse(new URL(target.url).searchParams.get("state")),
        );
        callbackUrl.searchParams.set("code", "synthetic-code");

        const cookie = (result: Response) =>
          result.headers
            .getSetCookie()
            .filter((value) => !value.includes("Max-Age=0"))
            .map((value) => value.split(";")[0])
            .join("; ");

        const completed = await environment.auth.handler(
          new Request(callbackUrl, { headers: { cookie: cookie(response) } }),
        );

        expect(completed.status).toBe(302);
        expect(completed.headers.get("location")).toBe("/settings");
        expect(visited).toEqual(
          new Set([metadata.token_endpoint, metadata.jwks_uri, metadata.userinfo_endpoint]),
        );

        const authenticated = await environment.auth.handler(
          new Request(`${origin}/api/auth/get-session`, {
            headers: { cookie: cookie(completed) },
          }),
        );

        expect(authenticated.status).toBe(200);
        expect(await authenticated.json()).toMatchObject({
          user: { email: profile.email, name: profile.name },
          session: { identityOrganizationId: "widefleet" },
        });

        request.mockClear();
        expect((await environment.auth.handler(signIn.clone())).status).toBe(200);
        expect(request).not.toHaveBeenCalled();
        const [unchanged] = await environment.database.db.select().from(ssoProvider);
        expect(unchanged?.oidcConfig).toBe(encrypted);

        request.mockClear();
        ipv4.mockClear();
        expect(await companySsoOrigins(environment.database.db, origin, encryptionKey)).toEqual([
          origin,
        ]);
        expect(
          await companySsoOrigins(
            environment.database.db,
            origin,
            encryptionKey,
            new Request(`${origin}/api/auth/sign-out`),
          ),
        ).toEqual([origin]);
        expect(
          await companySsoOrigins(
            environment.database.db,
            origin,
            encryptionKey,
            new Request(callback, { headers: { origin: "https://tokens.example.test" } }),
          ),
        ).toEqual([origin]);
        expect(
          await companySsoOrigins(
            environment.database.db,
            origin,
            encryptionKey,
            new Request(`${origin}/api/auth/sso/callback/missing`),
          ),
        ).toEqual([origin]);
        await environment.database.db.update(ssoProvider).set({ domainVerified: false });
        expect(
          await companySsoOrigins(
            environment.database.db,
            origin,
            encryptionKey,
            new Request(callback),
          ),
        ).toEqual([origin]);
        expect(request).not.toHaveBeenCalled();
        expect(ipv4).not.toHaveBeenCalled();
      } finally {
        request.mockRestore();
        ipv4.mockRestore();
        ipv6.mockRestore();
      }
    },
  );

  it("does not overwrite a provider edited while legacy discovery is in flight", async () => {
    await environment.database.db.delete(ssoProvider);

    const encryptionKey =
      environment.configuration.PLATFORM_ENCRYPTION_KEY ??
      environment.configuration.BETTER_AUTH_SECRET;

    const providerId = "concurrent-discovery";
    const issuer = "http://127.0.0.1:25439";
    const original = { clientId: "synthetic-client", clientSecret: "original-secret", issuer };

    const replacement = await encryptSecret(
      encryptionKey,
      JSON.stringify({ ...original, clientSecret: "rotated-secret" }),
    );

    await environment.database.db.insert(ssoProvider).values({
      id: crypto.randomUUID(),
      providerId,
      issuer,
      domain: "example.test",
      domainVerified: true,
      organizationId: "widefleet",
      oidcConfig: await encryptSecret(encryptionKey, JSON.stringify(original)),
    });

    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await environment.database.db.update(ssoProvider).set({ oidcConfig: replacement });

      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    });

    try {
      await expect(
        companySsoOrigins(
          environment.database.db,
          origin,
          encryptionKey,
          new Request(`${origin}/api/auth/sign-in/sso`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ providerId }),
          }),
        ),
      ).rejects.toMatchObject({ status: "CONFLICT" });
      const [stored] = await environment.database.db.select().from(ssoProvider);
      expect(stored?.oidcConfig).toBe(replacement);
    } finally {
      request.mockRestore();
    }
  });
});
