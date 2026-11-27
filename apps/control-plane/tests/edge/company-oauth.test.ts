import { authConfiguration } from "@platform/auth-proxy";
import { companyOAuth } from "@platform/auth-proxy/company-oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentityProvider } from "./auth-proxy-idp.ts";

describe("Company OAuth credentials for MCP", () => {
  let idp: Awaited<ReturnType<typeof createIdentityProvider>>;

  const configuration = () =>
    authConfiguration.parse({
      organizationId: "widefleet",
      provider: {
        type: "oidc",
        issuer: idp.origin,
        label: "Company",
        nameClaim: "display_name",
        emailClaim: "mail",
        groupsClaim: "roles",
      },
      clientId: "app-login",
      clientSecret: "synthetic-client-secret",
      cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
      domain: "apps.example.test",
      redirectUrl: "https://auth.apps.example.test/oauth2/widefleet/callback",
    });

  const start = async () => {
    const provider = await companyOAuth(configuration());
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const url = await provider.authorize("test-state", verifier, nonce);
    const response = await fetch(url, { redirect: "manual" });
    const callback = new URL(response.headers.get("location") ?? "invalid");
    const code = callback.searchParams.get("code") ?? "";

    return { provider, code, verifier, nonce };
  };

  beforeEach(async () => {
    idp = await createIdentityProvider();
  });
  afterEach(async () => {
    await idp.stop();
  });

  it("uses app identity mapping and refreshes the user's current groups without a control plane", async () => {
    idp.settings.rotateRefreshTokens = true;
    const { provider, code, verifier, nonce } = await start();
    const credential = await provider.exchange(code, verifier, nonce);
    expect(credential.authorization.identity).toMatchObject({
      id: "pairwise-subject",
      groups: ["accounting"],
    });
    expect(credential.refreshToken).toBeTruthy();
    idp.settings.groups = ["warehouse"];
    const renewal = await (await companyOAuth(configuration())).renew(credential);
    expect(renewal.status).toBe("renewed");
    expect(renewal.credential?.authorization.identity.groups).toEqual(["warehouse"]);
    expect(renewal.credential?.refreshToken).not.toBe(credential.refreshToken);
  });

  it("keeps the rotated credential and the previous authorization while signing keys are unavailable", async () => {
    idp.settings.rotateRefreshTokens = true;
    const { provider, code, verifier, nonce } = await start();
    const credential = await provider.exchange(code, verifier, nonce);
    idp.settings.keysAvailable = false;
    const unavailable = await (await companyOAuth(configuration())).renew(credential);

    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.credential?.authorization).toEqual(credential.authorization);
    expect(unavailable.credential?.refreshToken).not.toBe(credential.refreshToken);
    idp.settings.keysAvailable = true;
    idp.settings.groups = ["warehouse"];

    const renewed = await (
      await companyOAuth(configuration())
    ).renew(unavailable.credential ?? credential);

    expect(renewed.status).toBe("renewed");
    expect(renewed.credential?.authorization.identity.groups).toEqual(["warehouse"]);
  });

  it.each(["signature", "audience", "issuer", "expired"])(
    "rejects an invalid %s before accepting identity",
    async (failure) => {
      const { provider, code, verifier, nonce } = await start();
      idp.settings.failure = failure;
      await expect(provider.exchange(code, verifier, nonce)).rejects.toThrow();
    },
  );

  it("keeps the grant while the provider rejects the client credentials", async () => {
    const { provider, code, verifier, nonce } = await start();
    const credential = await provider.exchange(code, verifier, nonce);
    idp.settings.refreshFailure = "invalid_client";

    expect((await (await companyOAuth(configuration())).renew(credential)).status).toBe(
      "unavailable",
    );
    idp.settings.refreshFailure = "";
    expect((await (await companyOAuth(configuration())).renew(credential)).status).toBe("renewed");
  });

  it("binds authorization to the initiating nonce", async () => {
    const { provider, code, verifier } = await start();
    await expect(provider.exchange(code, verifier, "wrong-nonce")).rejects.toThrow();
  });

  it("rejects a refresh that changes the subject or omits fresh identity evidence", async () => {
    const { provider, code, verifier, nonce } = await start();
    const credential = await provider.exchange(code, verifier, nonce);
    idp.settings.subject = "other-person";
    expect((await provider.renew(credential)).status).toBe("sign-in-required");
    idp.settings.subject = "pairwise-subject";
    idp.settings.omitRefreshIdToken = true;
    expect((await provider.renew(credential)).status).toBe("sign-in-required");
  });
});
