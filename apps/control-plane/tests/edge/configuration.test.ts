import { describe, expect, it } from "vitest";
import {
  edgeInfrastructure,
  edgeRoutes,
  traefikConfiguration,
} from "../../tools/edge-configuration.ts";

const settings = {
  PLATFORM_URL: "https://platform.example.test",
  APP_DOMAIN: "apps.example.test",
  ENTRA_TENANT_ID: "00000000-0000-4000-8000-000000000001",
  APP_ENTRA_CLIENT_ID: "00000000-0000-4000-8000-000000000002",
};

describe("installation TLS configuration", () => {
  it("keeps provided certificates and does not enable an ACME resolver by default", () => {
    const configuration = edgeInfrastructure.parse(settings);
    expect(traefikConfiguration(configuration)).not.toHaveProperty("certificatesResolvers");
    expect(edgeRoutes(configuration).tls.certificates).toEqual([
      { certFile: "/tls/fullchain.pem", keyFile: "/tls/privkey.pem" },
    ]);
  });

  it.each(["production", "staging"])(
    "requests management and app wildcard together in %s",
    (stage) => {
      const configuration = edgeInfrastructure.parse({
        ...settings,
        TLS_MODE: "cloudflare",
        ACME_EMAIL: "operator@example.test",
        ACME_ENVIRONMENT: stage,
      });

      const proxySettings = traefikConfiguration(configuration);

      if (!("certificatesResolvers" in proxySettings)) throw new Error("Expected ACME resolver");
      const resolver = proxySettings.certificatesResolvers.letsencrypt.acme;
      expect(resolver.storage).toBe(`/acme/${stage}.json`);
      expect(resolver.caServer).toBe(
        stage === "staging"
          ? "https://acme-staging-v02.api.letsencrypt.org/directory"
          : "https://acme-v02.api.letsencrypt.org/directory",
      );
      expect(resolver.dnsChallenge.provider).toBe("cloudflare");
      const routes = edgeRoutes(configuration);
      expect(routes.tls.certificates).toEqual([]);
      expect(routes.http.routers.management.tls).toEqual({
        certResolver: "letsencrypt",
        domains: [{ main: "platform.example.test", sans: ["*.apps.example.test"] }],
      });
      expect(routes.http.routers["app-sso"].tls).toEqual({});
    },
  );

  it("rejects missing ACME details, unknown modes and overlapping management cookies", () => {
    expect(() => edgeInfrastructure.parse({ ...settings, TLS_MODE: "cloudflare" })).toThrow();
    expect(() => edgeInfrastructure.parse({ ...settings, TLS_MODE: "unknown" })).toThrow();
    expect(() => edgeInfrastructure.parse({ ...settings, ACME_ENVIRONMENT: "unknown" })).toThrow();

    for (const APP_DOMAIN of ["example.test", "platform.example.test"])
      expect(() => edgeRoutes(edgeInfrastructure.parse({ ...settings, APP_DOMAIN }))).toThrow(
        "outside APP_DOMAIN",
      );
  });
});
