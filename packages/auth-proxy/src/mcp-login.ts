import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";
import type { AuthConfiguration } from "./configuration.ts";

// Earlier releases also published Widefleet-owned Google and Microsoft registrations.
// Parsing strips them, so stored values remain readable until the next publication.
export const mcpLoginConfiguration = z.object({
  origin: z.url().refine((value) => {
    const url = new URL(value);

    return url.protocol === "https:" && url.origin === value && url.hostname.startsWith("mcp.");
  }),
  platformUrl: z.url(),
});

export const mcpLoginKey = "mcp/login";

export const encodeMcpLogin = (key: string, input: z.infer<typeof mcpLoginConfiguration>) =>
  symmetricEncrypt({ key, data: JSON.stringify(mcpLoginConfiguration.parse(input)) });

export const decodeMcpLogin = async (key: string, value: string) =>
  mcpLoginConfiguration.parse(JSON.parse(await symmetricDecrypt({ key, data: value })));

export const mcpTenantPrefix = (tenantId: string) =>
  `mcp/organizations/microsoft/${encodeURIComponent(tenantId)}/`;

// Entra tenants are found from an email domain through Microsoft's public discovery.
export const mcpOrganizationKey = (configuration: AuthConfiguration) => {
  const provider = configuration.provider;

  if (provider.type === "entra" && provider.authority === "https://login.microsoftonline.com")
    return `${mcpTenantPrefix(provider.tenantId)}${configuration.organizationId}`;

  return null;
};

export const mcpDomainPrefix = (domain: string) => `mcp/domains/${encodeURIComponent(domain)}/`;

export const mcpDomainKeys = (configuration: AuthConfiguration) =>
  (configuration.emailDomains ?? []).map(
    (domain) => `${mcpDomainPrefix(domain)}${configuration.organizationId}`,
  );
