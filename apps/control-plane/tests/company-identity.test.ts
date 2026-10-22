import { describe, expect, it } from "vitest";
import { companyProvider, settingsInput } from "@platform/contracts";
import { companyAccountProvider, companyIdentity } from "../src/lib/server/company-identity.ts";
import { installationSettings } from "./installation/settings.ts";

const client = { clientId: "client", clientSecret: "secret" };

describe("company identity settings", () => {
  it("keeps the installation account namespace", () => {
    const identity = companyIdentity.parse({
      provider: { type: "entra", tenantId: installationSettings.ENTRA_TENANT_ID },
      management: client,
    });

    expect(companyAccountProvider(identity)).toBe("microsoft");
  });

  it("uses issuer-scoped OIDC accounts", () => {
    const identity = companyIdentity.parse({
      provider: {
        type: "oidc",
        issuer: "https://login.example.test/realm/company",
        label: "Company",
        groupsClaim: "roles",
      },
      management: client,
    });

    const other = companyIdentity.parse({
      ...identity,
      provider: { ...identity.provider, issuer: "https://other.example.test" },
    });

    expect(companyAccountProvider(identity)).not.toBe(companyAccountProvider(other));
  });

  it("accepts one native SSO registration and independent directory credentials", () => {
    const settings = settingsInput.parse({
      sso: {
        appIdentityType: "entra",
        providerId: "company",
        issuer: "https://login.example.test",
        domain: "example.test",
        oidcConfig: client,
      },
      directory: { clientId: "directory", clientSecret: "directory-secret" },
    });

    expect(settings.sso?.oidcConfig.clientId).toBe("client");
    expect(settings.directory?.clientId).toBe("directory");
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
