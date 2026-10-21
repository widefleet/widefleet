import { sha256 } from "@noble/hashes/sha2.js";
import { companyProvider } from "@platform/contracts";
import type { z } from "zod";
import { installationOrganizationId } from "./organization.ts";

const hash = (value: string) =>
  Array.from(sha256(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);

export const providerIssuer = (provider: z.infer<typeof companyProvider>) =>
  provider.type === "entra"
    ? `${new URL(provider.authority).origin}/${provider.tenantId}/v2.0`
    : provider.issuer.replace(/\/$/, "");

export const companyAccountProvider = (
  identity: { provider: z.infer<typeof companyProvider> },
  organizationId = installationOrganizationId,
) => {
  if (organizationId !== installationOrganizationId)
    return `oidc-${hash(JSON.stringify([organizationId, providerIssuer(identity.provider)]))}`;

  // OIDC issuers get isolated account namespaces; the installation Entra provider has a stable key.
  return identity.provider.type === "entra"
    ? "microsoft"
    : `oidc-${hash(providerIssuer(identity.provider))}`;
};
