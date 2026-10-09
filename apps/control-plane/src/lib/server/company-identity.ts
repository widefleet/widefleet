import { createHash } from "node:crypto";
import { z } from "zod";

import { companyProvider } from "@platform/contracts";

export { companyProvider, identityUrl } from "@platform/contracts";

const credentials = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });

export const companyIdentity = z.object({
  provider: companyProvider,
  management: credentials,
  directory: credentials.nullable().default(null),
});

export const providerIssuer = (provider: z.infer<typeof companyProvider>) =>
  provider.type === "entra"
    ? `${new URL(provider.authority).origin}/${provider.tenantId}/v2.0`
    : provider.issuer.replace(/\/$/, "");

export const companyAccountProvider = (
  identity: Pick<z.infer<typeof companyIdentity>, "provider">,
) => {
  // OIDC issuers get isolated account namespaces. Entra uses its verified object ID.
  return identity.provider.type === "entra"
    ? "microsoft"
    : `oidc-${createHash("sha256").update(providerIssuer(identity.provider)).digest("hex").slice(0, 24)}`;
};
