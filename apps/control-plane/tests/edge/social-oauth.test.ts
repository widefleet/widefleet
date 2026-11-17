import { socialOAuth } from "@platform/auth-proxy/social-oauth";
import { mcpLoginConfiguration } from "@platform/auth-proxy/mcp-login";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityProvider, tenantId, objectId } from "./auth-proxy-idp.ts";

const origin = "https://mcp.apps.example.test";

const configuration = mcpLoginConfiguration.parse({
  origin,
  platformUrl: "https://platform.example.test",
  google: { clientId: "app-login", clientSecret: "synthetic-client-secret" },
  microsoft: { clientId: "app-login", clientSecret: "synthetic-client-secret" },
});

describe.each(["google", "microsoft"] as const)("MCP %s company discovery", (provider) => {
  let idp: Awaited<ReturnType<typeof createIdentityProvider>>;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    idp = await createIdentityProvider(`${origin}/oauth/callback/${provider}`);
  });
  afterAll(async () => {
    await idp.stop();
  });
  beforeEach(() => {
    idp.settings.failure = "";
    idp.settings.workspaceDomain = "example.test";
    idp.settings.google = provider === "google";
    idp.settings.entra = provider === "microsoft";
    idp.settings.entraAuthority = "https://login.microsoftonline.com";
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname.endsWith("/token") ? "/token" : "/jwks";

      if (
        [
          "https://oauth2.googleapis.com",
          "https://www.googleapis.com",
          "https://login.microsoftonline.com",
        ].includes(url.origin)
      )
        return realFetch(new Request(new URL(path, idp.origin), request));

      throw new Error(`Unexpected external request to ${url.origin}`);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const start = async () => {
    const social = socialOAuth(configuration, provider);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const url = await social.authorize("state", verifier, nonce);
    expect(url.searchParams.get("nonce")).toBe(nonce);
    expect(url.searchParams.get("scope")).not.toContain("cloud-identity");

    const response = await realFetch(`${idp.origin}/authorize${url.search}`, {
      redirect: "manual",
    });

    const code =
      new URL(response.headers.get("location") ?? "invalid").searchParams.get("code") ?? "";

    return { social, verifier, nonce, code };
  };

  it("discovers the company from a verified identity with no prior organization input", async () => {
    const { social, verifier, nonce, code } = await start();
    const result = await social.exchange(code, verifier, nonce);
    expect(result.identity).toEqual(
      provider === "google"
        ? { provider, tenant: "example.test", subject: "pairwise-subject" }
        : { provider, tenant: tenantId, subject: objectId },
    );
    expect(result.tokens.refreshToken).toBeTruthy();
  });

  it.each(["signature", "audience", "issuer", "expired", "nonce"])(
    "rejects %s failure before choosing a company",
    async (failure) => {
      const { social, verifier, nonce, code } = await start();
      idp.settings.failure = failure;
      await expect(social.exchange(code, verifier, nonce)).rejects.toThrow();
    },
  );
});
