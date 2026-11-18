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
import { organizationSettings, ssoDomains } from "../src/lib/server/schema.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { organization, ssoProvider } from "../src/lib/server/auth-schema.ts";
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

    expect(z.object({ domainVerified: z.boolean() }).parse(created).domainVerified).toBe(false);
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
    resolver.mockResolvedValue([
      [z.object({ domainVerificationToken: z.string() }).parse(created).domainVerificationToken],
    ]);
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

  it("adds domains to an activated connection and verifies each separately", async () => {
    const principal = {
      ...environment.owner,
      role: "owner" as const,
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    };

    const credential = await organizationCredential(environment, principal);
    const next = editableSettings(await environment.settings.read(principal));

    expect(environment.authControl.read().configuration?.provider).toMatchObject({
      groupsClaim: "groups",
    });

    if (!next.sso) throw new Error("Missing fixture provider");
    next.sso.domain = "changed.example.test, Alias.example.test";
    next.sso.oidcConfig.mapping.extraFields.groups = "roles";
    await expect(
      environment.settings.update(
        principal,
        { ...next, acknowledgeRestart: false },
        false,
        credential,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Keep a verified email domain while company SSO is required",
    });
    // The rejected import changed neither the domains nor the connection.
    const unchanged = await environment.settings.read(principal);
    expect(unchanged.sso?.oidcConfig.mapping.extraFields.groups).toBe("groups");
    expect(unchanged.ssoDomains.map((entry) => entry.domain)).toEqual(["example.test"]);

    next.sso.domain = "example.test, changed.example.test, Alias.example.test";

    const updated = await environment.settings.update(
      principal,
      { ...next, acknowledgeRestart: false },
      false,
      credential,
    );
    // Pending domains leave the verified one and the required connection untouched.

    expect(updated.ssoRequired).toBe(true);
    expect(environment.authControl.read().configuration?.provider).toMatchObject({
      groupsClaim: "roles",
    });

    const proof = await environment.settings.domainVerification(principal);
    const [alias, changed] = proof.records;

    expect(proof.records.map(({ domain, name, type }) => ({ domain, name, type }))).toEqual([
      {
        domain: "alias.example.test",
        name: "_better-auth-token-test-company.alias.example.test",
        type: "TXT",
      },
      {
        domain: "changed.example.test",
        name: "_better-auth-token-test-company.changed.example.test",
        type: "TXT",
      },
    ]);
    expect(alias?.value).not.toBe(changed?.value);
    expect(proof.name).toBe(alias?.name);
    expect((await environment.settings.read(principal)).sso?.domain).toBe(
      "alias.example.test,changed.example.test,example.test",
    );

    // Each domain is proven by its own record and stays verified independently.
    resolver.mockImplementation(async (name) => (name === changed?.name ? [[changed.value]] : []));
    await expect(environment.settings.verifyDomain(principal)).rejects.toThrow(
      "No matching TXT record was found for alias.example.test.",
    );

    const partial = await environment.settings.read(principal);
    expect(partial.ssoDomains.map(({ domain, verified }) => ({ domain, verified }))).toEqual([
      { domain: "alias.example.test", verified: false },
      { domain: "changed.example.test", verified: true },
      { domain: "example.test", verified: true },
    ]);
    expect(partial.ssoRequired).toBe(true);

    const [stored] = await environment.database.db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.providerId, "test-company"));

    expect(stored?.domain).toBe("changed.example.test,example.test");

    // Records published for earlier releases use Better Auth's identifier=value form.
    resolver.mockImplementation(async (name) =>
      name === alias?.name ? [[`_better-auth-token-test-company=${alias.value}`]] : [],
    );
    await environment.settings.verifyDomain(principal, "alias.example.test");

    const [both] = await environment.database.db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.providerId, "test-company"));

    expect(both?.domain).toBe("alias.example.test,changed.example.test,example.test");
    expect(both?.domainVerified).toBe(true);
  });

  it("adds and removes domains without interrupting required company SSO", async () => {
    const principal = {
      ...environment.owner,
      role: "owner" as const,
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    };

    const added = await environment.settings.addDomain(principal, "new.example.test", false);
    expect(added.ssoRequired).toBe(true);
    expect(added.ssoDomains.find((entry) => entry.domain === "new.example.test")).toMatchObject({
      verified: false,
      record: { name: "_better-auth-token-test-company.new.example.test", type: "TXT" },
    });
    await expect(
      environment.settings.addDomain(principal, "new.example.test", false),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [stored] = await environment.database.db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.providerId, "test-company"));

    expect(stored).toMatchObject({
      domain: "alias.example.test,changed.example.test,example.test",
      domainVerified: true,
    });

    for (const domain of ["new.example.test", "alias.example.test", "changed.example.test"])
      await environment.settings.removeDomain(principal, domain, false);
    await expect(
      environment.settings.removeDomain(principal, "example.test", false),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Keep at least one company email domain",
    });

    await environment.settings.addDomain(principal, "pending.example.test", false);
    await expect(
      environment.settings.removeDomain(principal, "example.test", false),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Keep a verified email domain while company SSO is required",
    });
    expect((await environment.settings.read(principal)).ssoRequired).toBe(true);
  });

  it("keeps every domain verified by concurrent checks", async () => {
    const principal = {
      ...environment.owner,
      role: "owner" as const,
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    };

    const domains = ["first.example.test", "second.example.test"];

    for (const domain of domains) await environment.settings.addDomain(principal, domain, false);

    const records = new Map(
      (await environment.settings.read(principal)).ssoDomains.flatMap((entry) =>
        entry.record ? [[entry.record.name, entry.record.value]] : [],
      ),
    );

    resolver.mockImplementation(async (name) => [[records.get(name) ?? ""]]);
    await Promise.all(
      domains.map((domain) => environment.settings.verifyDomain(principal, domain)),
    );

    const [stored] = await environment.database.db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.providerId, "test-company"));

    expect(stored?.domain.split(",")).toEqual(expect.arrayContaining(domains));

    for (const domain of domains) await environment.settings.removeDomain(principal, domain, false);
  });

  it("lets organizations that control the same DNS verify a shared domain", async () => {
    const organizationId = crypto.randomUUID();
    await environment.database.db.insert(organization).values({
      id: organizationId,
      name: "Other company",
      slug: `other-${organizationId}`,
      createdAt: new Date(),
    });
    await environment.database.db.insert(ssoProvider).values({
      id: crypto.randomUUID(),
      providerId: `other-${organizationId}`,
      organizationId,
      issuer: "https://other.example.test",
      domain: "claimed.example.test",
      domainVerified: true,
    });
    await environment.database.db.insert(ssoDomains).values({
      organizationId,
      domain: "claimed.example.test",
      verificationToken: "other-token",
      verifiedAt: new Date(),
    });

    const principal = {
      ...environment.owner,
      role: "owner" as const,
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    };

    try {
      const view = await environment.settings.addDomain(principal, "claimed.example.test", false);
      const record = view.ssoDomains.find((entry) => entry.domain === "claimed.example.test");
      resolver.mockResolvedValue([[record?.record?.value ?? ""]]);
      await environment.settings.verifyDomain(principal, "claimed.example.test");
      expect(
        (await environment.settings.read(principal)).ssoDomains.find(
          (entry) => entry.domain === "claimed.example.test",
        )?.verified,
      ).toBe(true);
    } finally {
      await environment.settings.removeDomain(principal, "claimed.example.test", false);
      await environment.database.db.delete(organization).where(eq(organization.id, organizationId));
    }
  });

  it.each(["registered", "migrated"])(
    "completes %s-provider sign-in without changing stored configuration",
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
        visited.clear();
        const [before] = await environment.database.db.select().from(ssoProvider);
        const encrypted = z.string().parse(before?.oidcConfig);

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
        expect(visited).toEqual(
          new Set(kind === "migrated" ? [`${issuer}/.well-known/openid-configuration`] : []),
        );

        const [saved] = await environment.database.db.select().from(ssoProvider);
        expect(saved?.oidcConfig).toBe(encrypted);
        expect(encrypted).not.toContain(input.oidcConfig.clientSecret);
        expect(JSON.parse(await decryptSecret(encryptionKey, encrypted))).toMatchObject({
          clientSecret: kind === "registered" ? rotatedSecret : input.oidcConfig.clientSecret,
        });
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
        expect(
          completed.headers
            .getSetCookie()
            .some((value) => value.startsWith("platform.last_used_login_method=sso;")),
        ).toBe(true);
        expect(visited).toEqual(
          new Set([
            metadata.token_endpoint,
            metadata.jwks_uri,
            metadata.userinfo_endpoint,
            ...(kind === "migrated" ? [`${issuer}/.well-known/openid-configuration`] : []),
          ]),
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
        visited.clear();
        expect((await environment.auth.handler(signIn.clone())).status).toBe(200);
        expect(visited).toEqual(
          new Set(kind === "migrated" ? [`${issuer}/.well-known/openid-configuration`] : []),
        );
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
});
