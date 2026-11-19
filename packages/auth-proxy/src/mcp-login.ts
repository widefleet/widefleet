import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";
import type { AuthConfiguration } from "./configuration.ts";

const registration = z.strictObject({
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(16_384),
});

export const mcpLoginConfiguration = z.strictObject({
  origin: z.url().refine((value) => {
    const url = new URL(value);

    return url.protocol === "https:" && url.origin === value && url.hostname.startsWith("mcp.");
  }),
  platformUrl: z.url(),
  google: registration.optional(),
  microsoft: registration.optional(),
});

export const mcpLoginKey = "mcp/login";

export const encodeMcpLogin = (key: string, input: z.infer<typeof mcpLoginConfiguration>) =>
  symmetricEncrypt({ key, data: JSON.stringify(mcpLoginConfiguration.parse(input)) });

export const decodeMcpLogin = async (key: string, value: string) =>
  mcpLoginConfiguration.parse(JSON.parse(await symmetricDecrypt({ key, data: value })));

export const mcpOrganizationPrefix = (provider: "google" | "microsoft", tenant: string) =>
  `mcp/organizations/${provider}/${encodeURIComponent(tenant)}/`;

export const mcpOrganizationKey = (configuration: AuthConfiguration) => {
  const provider = configuration.provider;

  if (provider.type === "google")
    return `${mcpOrganizationPrefix("google", provider.domain)}${configuration.organizationId}`;

  if (provider.type === "entra" && provider.authority === "https://login.microsoftonline.com")
    return `${mcpOrganizationPrefix("microsoft", provider.tenantId)}${configuration.organizationId}`;

  return null;
};

export const mcpDomainPrefix = (domain: string) => `mcp/domains/${encodeURIComponent(domain)}/`;

export const mcpDomainKeys = (configuration: AuthConfiguration) =>
  (configuration.emailDomains ?? []).map(
    (domain) => `${mcpDomainPrefix(domain)}${configuration.organizationId}`,
  );
