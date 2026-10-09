import { describe, expect, it } from "vitest";
import { companyProvider, identitySettingsInput } from "@platform/contracts";
import { configurationSchema } from "../src/lib/server/config.ts";
import { managementProviders } from "../src/lib/server/auth-options.ts";
import { companyAccountProvider, companyIdentity } from "../src/lib/server/company-identity.ts";
import { appSsoConfiguration } from "../tools/edge-configuration.ts";
import { installationSettings } from "./installation/settings.ts";

const infrastructure = configurationSchema.parse({
  ...installationSettings,
  S3_ENDPOINT: "http://127.0.0.1:25400",
  S3_BUCKET: "artifacts",
});

const client = { clientId: "client", clientSecret: "secret" };

describe("company identity settings", () => {
  it("starts without a provider and enables only the configured management login", () => {
    expect(managementProviders(infrastructure)).toEqual([]);

    const identity = companyIdentity.parse({
      provider: { type: "entra", tenantId: installationSettings.ENTRA_TENANT_ID },
      management: client,
    });

    expect(companyAccountProvider(identity)).toBe("microsoft");
    expect(managementProviders({ ...infrastructure, IDENTITY: identity })[0]).toMatchObject({
      providerId: "microsoft",
      clientId: "client",
      requireIdTokenVerification: true,
    });
    expect(appSsoConfiguration(identity.provider, "apps", "/secret").providers[0]).toMatchObject({
      provider: "entra-id",
      scope: "openid profile email User.Read",
      clientID: "apps",
    });
  });

  it("uses generic OIDC for management and app sign-in, with issuer-scoped accounts", () => {
    const identity = companyIdentity.parse({
      provider: {
        type: "oidc",
        issuer: "https://login.example.test/realm/company",
        label: "Company",
        groupsClaim: "roles",
      },
      management: client,
    });

    expect(managementProviders({ ...infrastructure, IDENTITY: identity })[0]).toMatchObject({
      clientId: "client",
      discoveryUrl: "https://login.example.test/realm/company/.well-known/openid-configuration",
      requireIdTokenVerification: true,
    });
    const proxy = appSsoConfiguration(identity.provider, "apps", "/secret");
    expect(proxy.providers[0]).toMatchObject({
      provider: "oidc",
      oidcConfig: { groupsClaim: "roles" },
    });
    expect(proxy.injectResponseHeaders).toContainEqual({
      name: "X-Auth-Request-User",
      values: [{ claimSource: { claim: "sub" } }],
    });

    const other = companyIdentity.parse({
      ...identity,
      provider: { ...identity.provider, issuer: "https://other.example.test" },
    });

    expect(companyAccountProvider(identity)).not.toBe(companyAccountProvider(other));
  });

  it("accepts separate Graph credentials and rejects Graph for another provider", () => {
    const clients = {
      management: { clientId: "management", secret: { type: "value", value: "management-secret" } },
      apps: { clientId: "apps", secret: { type: "value", value: "apps-secret" } },
      directory: { clientId: "directory", secret: { type: "value", value: "directory-secret" } },
    };

    expect(
      identitySettingsInput.parse({
        ...clients,
        provider: { type: "entra", tenantId: installationSettings.ENTRA_TENANT_ID },
      }).directory?.clientId,
    ).toBe("directory");
    expect(() =>
      identitySettingsInput.parse({
        ...clients,
        provider: { type: "oidc", issuer: "https://login.example.test", label: "Company" },
      }),
    ).toThrow("Microsoft Graph directory search requires an Entra provider");
  });

  it("rejects unsafe issuer URLs and invalid claim names", () => {
    for (const overrides of [
      { issuer: "http://login.example.test" },
      { issuer: "https://user:password@login.example.test" },
      { groupsClaim: "invalid claim" },
    ])
      expect(
        companyProvider.safeParse({
          type: "oidc",
          issuer: "https://login.example.test",
          label: "Company",
          ...overrides,
        }).success,
      ).toBe(false);
  });
});
