import { describe, expect, it } from "vitest";
import { z } from "zod";
import { companyProvider, googleGroupsScope, settingsInput } from "@platform/contracts";
import { companyAccountProvider, companyIdentity } from "../src/lib/server/company-identity.ts";
import { installationSettings } from "./installation/settings.ts";
import { createInstalledAppSignIn } from "../src/lib/server/app-sign-in-installed.ts";
import { configurationSchema } from "../src/lib/server/config.ts";
import { authConfiguration } from "@platform/auth-proxy";

const client = { clientId: "client", clientSecret: "secret" };

describe("company identity settings", () => {
  it.each([{ scopes: [] }, { scopes: [googleGroupsScope] }])(
    "publishes Google sign-in with optional scopes %j and no directory",
    async ({ scopes }) => {
      const identity = companyIdentity.parse({
        provider: { type: "google", domain: "example.test" },
        management: client,
        scopes,
      });

      let published: z.infer<typeof authConfiguration> | undefined;

      const appSignIn = createInstalledAppSignIn(
        configurationSchema.parse({
          ...installationSettings,
          S3_ENDPOINT: "http://127.0.0.1:25400",
          S3_BUCKET: "artifacts",
        }),
        Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"),
        async (path, method, body) => {
          expect(method).toBe("PUT");

          if (path !== "/mcp/login")
            published = authConfiguration.parse(JSON.parse(z.string().parse(body)));

          return { text: async () => "" };
        },
        "immediate",
      );

      await appSignIn.publish(identity, client.clientSecret);
      expect(published?.scopes).toEqual(scopes);
      expect(published?.provider).toMatchObject({
        type: "google",
        issuer: "https://accounts.google.com",
        domain: "example.test",
      });
    },
  );
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
