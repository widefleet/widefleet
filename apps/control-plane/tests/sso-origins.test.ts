import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCompanyOidc } from "../src/lib/server/sso-origins.ts";

const fixture = () => {
  const issuer = `https://accounts.example.test/${crypto.randomUUID()}`;

  const document = {
    issuer,
    authorization_endpoint: "https://accounts.example.test/authorize",
    token_endpoint: "https://tokens.example.test/token",
    jwks_uri: "https://keys.example.test/certs",
    userinfo_endpoint: "https://profile.example.test/userinfo",
    revocation_endpoint: "https://tokens.example.test/revoke",
  };

  const request = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(document));

  const ipv4 = vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"]);
  const ipv6 = vi.spyOn(dns, "resolve6").mockResolvedValue([]);

  return { issuer, document, request, ipv4, ipv6 };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Company SSO discovery origins", () => {
  it("derives multiple exact origins from the configured issuer without sending credentials", async () => {
    const { issuer, request } = fixture();

    expect((await prepareCompanyOidc(issuer, {})).origins).toEqual([
      "https://accounts.example.test",
      "https://tokens.example.test",
      "https://keys.example.test",
      "https://profile.example.test",
    ]);
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0] ?? [];
    expect(url).toEqual(new URL(`${issuer}/.well-known/openid-configuration`));
    expect(options).toMatchObject({ method: "GET", redirect: "manual" });
    const headers = new Headers(options?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(options?.body ?? null).toBeNull();
  });

  it("uses saved endpoints without discovery and still rechecks DNS", async () => {
    const { issuer, request, ipv4 } = fixture();

    const prepared = await prepareCompanyOidc(issuer, {
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
    });

    expect(prepared.configuration).toMatchObject({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      tokenEndpoint: "https://tokens.example.test/token",
    });
    request.mockClear();
    ipv4.mockClear();
    request.mockRejectedValue(new Error("Discovery is unavailable"));

    const saved = await prepareCompanyOidc(issuer, {
      ...prepared.configuration,
      discoveryEndpoint: "https://offline.example.test/openid",
    });

    expect(saved.origins).toEqual(prepared.origins);
    expect(saved.discovered).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(ipv4).toHaveBeenCalledTimes(3);
  });

  it("preserves explicit endpoints when completing a partial configuration", async () => {
    const { issuer } = fixture();

    const prepared = await prepareCompanyOidc(issuer, {
      tokenEndpoint: "https://custom.example.test/token",
      tokenEndpointAuthentication: "client_secret_post",
      scopes: ["openid"],
    });

    expect(prepared.configuration).toMatchObject({
      tokenEndpoint: "https://custom.example.test/token",
      tokenEndpointAuthentication: "client_secret_post",
      scopes: ["openid"],
      jwksEndpoint: "https://keys.example.test/certs",
    });
    expect(prepared.origins).toContain("https://custom.example.test");
  });

  it("checks a custom discovery host before fetching it", async () => {
    const { issuer, request, ipv4 } = fixture();
    ipv4.mockResolvedValue(["10.0.0.1"]);
    await expect(
      prepareCompanyOidc(issuer, {
        discoveryEndpoint: "https://discovery.example.test/openid",
      }),
    ).rejects.toMatchObject({ code: "discovery_private_host" });
    expect(request).not.toHaveBeenCalled();

    ipv4.mockResolvedValue(["93.184.216.34"]);
    await prepareCompanyOidc(issuer, {
      discoveryEndpoint: "https://discovery.example.test/openid",
    });
    expect(request.mock.calls[0]?.[0]).toEqual(new URL("https://discovery.example.test/openid"));
  });

  it("isolates issuers and does not reuse failed discovery", async () => {
    const { issuer, document, request } = fixture();
    document.issuer = "https://foreign.example.test";

    await expect(prepareCompanyOidc(issuer, {})).rejects.toMatchObject({ code: "issuer_mismatch" });
    document.issuer = issuer;
    await prepareCompanyOidc(issuer, {});
    expect(request).toHaveBeenCalledTimes(2);
    await expect(prepareCompanyOidc("https://another.example.test", {})).rejects.toMatchObject({
      code: "issuer_mismatch",
    });
  });

  it("rejects incomplete metadata and discovery redirects", async () => {
    const { issuer, request } = fixture();
    request.mockResolvedValueOnce(Response.json({ issuer }));
    await expect(prepareCompanyOidc(issuer, {})).rejects.toMatchObject({
      code: "discovery_incomplete",
    });
    request.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://foreign.example.test" } }),
    );
    await expect(prepareCompanyOidc(issuer, {})).rejects.toMatchObject({
      code: "oidc_endpoint_redirect",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    "http://tokens.example.test/token",
    "https://user:password@tokens.example.test/token",
    "https://tokens.example.test/token#fragment",
    "https://*.example.test/token",
    "https://127.0.0.1/token",
    "https://[::1]/token",
    "https://10.0.0.1/token",
    "https://169.254.169.254/token",
    "https://metadata.google.internal/token",
  ])("rejects an unsafe discovered endpoint: %s", async (endpoint) => {
    const { issuer, document, request } = fixture();
    document.token_endpoint = endpoint;

    await expect(prepareCompanyOidc(issuer, {})).rejects.toMatchObject({
      code: "discovery_untrusted_origin",
    });
    request.mockClear();
    await expect(
      prepareCompanyOidc(issuer, {
        authorizationEndpoint: document.authorization_endpoint,
        tokenEndpoint: endpoint,
        jwksEndpoint: document.jwks_uri,
      }),
    ).rejects.toMatchObject({ code: "discovery_untrusted_origin" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects private addresses in either DNS family for saved endpoints too", async () => {
    const { issuer, request, ipv4, ipv6 } = fixture();

    const saved = (await prepareCompanyOidc(issuer, {})).configuration;
    request.mockClear();
    ipv4.mockResolvedValue(["93.184.216.34", "10.0.0.1"]);
    await expect(prepareCompanyOidc(issuer, saved)).rejects.toMatchObject({
      code: "discovery_private_host",
    });
    ipv4.mockResolvedValue(["93.184.216.34"]);
    ipv6.mockResolvedValue(["::ffff:127.0.0.1"]);
    await expect(prepareCompanyOidc(issuer, saved)).rejects.toMatchObject({
      code: "discovery_private_host",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("allows absent IPv6 records but fails closed on DNS errors or no addresses", async () => {
    const { issuer, ipv4, ipv6 } = fixture();
    ipv6.mockRejectedValue({ code: "ENODATA" });
    await prepareCompanyOidc(issuer, {});
    ipv6.mockRejectedValue({ code: "ETIMEOUT" });
    await expect(prepareCompanyOidc(issuer, {})).rejects.toMatchObject({ code: "ETIMEOUT" });
    ipv6.mockRejectedValue({ code: "ENODATA" });
    ipv4.mockRejectedValue({ code: "ENOTFOUND" });
    await expect(prepareCompanyOidc(issuer, {})).rejects.toMatchObject({
      code: "discovery_private_host",
    });
  });

  it("preserves explicitly configured loopback development issuers", async () => {
    const { document, request, ipv4 } = fixture();
    const issuer = `http://127.0.0.1:25439/${crypto.randomUUID()}`;
    request.mockResolvedValue(
      Response.json({
        ...document,
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        revocation_endpoint: `${issuer}/revoke`,
      }),
    );

    expect((await prepareCompanyOidc(issuer, {})).origins).toEqual(["http://127.0.0.1:25439"]);
    expect(ipv4).not.toHaveBeenCalled();
  });
});
