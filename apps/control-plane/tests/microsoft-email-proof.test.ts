import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";

const baseURL = "https://platform.example.test";

const clientId = "synthetic-microsoft-client";

const tenantId = "11111111-1111-4111-8111-111111111111";

const accountId = "22222222-2222-4222-8222-222222222222";

const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;

const email = "member@example.test";

const kid = "synthetic-microsoft-signing-key";

describe("Microsoft email domain proof", () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fixture = async (emailVerified = true) => {
    const publicKey = await exportJWK(keys.publicKey);

    // The real provider verifies signed tokens against a synthetic JWKS. No
    // Microsoft request or email delivery is made by this regression test.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const request = new Request(input);

        expect(request.url).toBe("https://login.microsoftonline.com/common/discovery/v2.0/keys");

        return Response.json({ keys: [{ ...publicKey, kid, alg: "RS256", use: "sig" }] });
      }),
    );

    const auth = betterAuth({
      baseURL,
      secret: "synthetic-microsoft-regression-secret-only",
      database: memoryAdapter({ user: [], account: [], session: [], verification: [] }),
      socialProviders: {
        microsoft: {
          clientId,
          clientSecret: "synthetic-client-secret",
          tenantId: "common",
          disableProfilePhoto: true,
        },
      },
      account: { accountLinking: { enabled: true, requireLocalEmailVerified: true } },
      advanced: { disableCSRFCheck: false, disableOriginCheck: false },
      logger: { disabled: true },
    });

    const { internalAdapter } = await auth.$context;

    const user = await internalAdapter.createUser(
      { name: "Existing member", email, emailVerified },
      { method: "email-otp" },
    );

    const token = (claims: ConstructorParameters<typeof SignJWT>[0]) =>
      new SignJWT({
        name: "Microsoft member",
        email,
        oid: accountId,
        tid: tenantId,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject("synthetic-microsoft-subject")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);

    const signIn = (idToken: string) =>
      auth.handler(
        new Request(`${baseURL}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseURL },
          body: JSON.stringify({ provider: "microsoft", idToken: { token: idToken } }),
        }),
      );

    return { user, internalAdapter, token, signIn };
  };

  it("links a matching verified local user when Microsoft proves the email domain", async () => {
    const { user, internalAdapter, token, signIn } = await fixture();
    const response = await signIn(await token({ xms_edov: true }));

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: user.id, emailVerified: true } });
    expect(await internalAdapter.findAccounts(user.id)).toMatchObject([
      { providerId: "microsoft", accountId, userId: user.id },
    ]);
  });

  it.each([
    { label: "missing proof", claims: {} },
    { label: "unverified domain", claims: { xms_edov: false } },
    { label: "string true", claims: { xms_edov: "true" } },
    { label: "string false", claims: { xms_edov: "false" } },
    { label: "numeric true", claims: { xms_edov: 1 } },
    { label: "null proof", claims: { xms_edov: null } },
    { label: "explicit unverified email", claims: { xms_edov: true, email_verified: false } },
    { label: "missing email", claims: { xms_edov: true, email: undefined } },
    { label: "empty email", claims: { xms_edov: true, email: "" } },
    {
      label: "a different verified address",
      claims: { verified_primary_email: ["other@example.test"] },
    },
  ])("does not link with $label", async ({ claims }) => {
    const { user, internalAdapter, token, signIn } = await fixture();
    const response = await signIn(await token(claims));

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await internalAdapter.findAccounts(user.id)).toEqual([]);
    expect(await internalAdapter.listSessions(user.id)).toEqual([]);
  });

  it.each([
    { label: "verified email", claims: { email_verified: true } },
    { label: "verified primary address", claims: { verified_primary_email: [email] } },
    { label: "verified secondary address", claims: { verified_secondary_email: [email] } },
    {
      label: "verified address without a verified domain",
      claims: { xms_edov: false, verified_primary_email: [email] },
    },
  ])("preserves linking with $label", async ({ claims }) => {
    const { user, token, signIn } = await fixture();
    const response = await signIn(await token(claims));

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: user.id } });
  });

  it("requires the existing local account to be verified", async () => {
    const { user, internalAdapter, token, signIn } = await fixture(false);
    const response = await signIn(await token({ xms_edov: true }));

    expect(response.status).toBe(401);
    expect(await internalAdapter.findAccounts(user.id)).toEqual([]);
  });

  it("recognizes an already linked identity without fresh email domain proof", async () => {
    const { user, internalAdapter, token, signIn } = await fixture();

    await internalAdapter.createAccount({ providerId: "microsoft", accountId, userId: user.id });

    const response = await signIn(await token({}));

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: user.id } });
    expect(await internalAdapter.findAccounts(user.id)).toHaveLength(1);
  });

  it("rejects a forged token even when it claims a verified domain", async () => {
    const { user, internalAdapter, token, signIn } = await fixture();
    const signed = await token({ xms_edov: true });
    const parts = z.tuple([z.string(), z.string(), z.string()]).parse(signed.split("."));
    const forgedSignature = `${parts[2].startsWith("A") ? "B" : "A"}${parts[2].slice(1)}`;
    const response = await signIn(`${parts[0]}.${parts[1]}.${forgedSignature}`);

    expect(response.status).toBe(401);
    expect(await internalAdapter.findAccounts(user.id)).toEqual([]);
  });

  it("rejects a token whose tenant does not match its issuer", async () => {
    const { user, internalAdapter, token, signIn } = await fixture();

    const response = await signIn(
      await token({ xms_edov: true, tid: "33333333-3333-4333-8333-333333333333" }),
    );

    expect(response.status).toBe(401);
    expect(await internalAdapter.findAccounts(user.id)).toEqual([]);
  });
});
