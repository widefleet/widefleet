import { eq } from "drizzle-orm";
import { z } from "zod";
import { oidcProviderInput } from "@platform/contracts";
import { organizationSettings } from "./schema.ts";
import { ssoProvider } from "./auth-schema.ts";
import { companyIdentity } from "./company-identity.ts";
import type { DatabaseExecutor } from "./database.ts";
import { decryptSecret } from "./secret-encryption.ts";
import type { OrganizationCredential } from "./organization-operations.ts";
import { InvalidOperation } from "./errors.ts";

export const readSsoProvider = async (database: DatabaseExecutor, organizationId: string) => {
  const [record] = await database
    .select({ provider: ssoProvider, required: organizationSettings.ssoRequired })
    .from(ssoProvider)
    .leftJoin(
      organizationSettings,
      eq(organizationSettings.organizationId, ssoProvider.organizationId),
    )
    .where(eq(ssoProvider.organizationId, organizationId));

  return record ? { ...record.provider, required: record.required === true } : null;
};

// The runtime reads the native provider. This is a published consumer view, never
// a second editable/persisted SSO connection.
export const readSsoConfiguration = async (
  database: DatabaseExecutor,
  key: string,
  organizationId: string,
) => {
  const provider = await readSsoProvider(database, organizationId);

  if (!provider?.oidcConfig) return null;

  const oidcConfig = oidcProviderInput.shape.oidcConfig
    .strip()
    .parse(JSON.parse(await decryptSecret(key, provider.oidcConfig)));

  return {
    ...provider,
    appIdentityType: oidcProviderInput.shape.appIdentityType.parse(provider.appIdentityType),
    oidcConfig,
  };
};

export const ssoRuntimeIdentity = (
  connection: NonNullable<Awaited<ReturnType<typeof readSsoConfiguration>>>,
) => {
  const configuration = connection.oidcConfig;
  const issuer = new URL(connection.issuer);
  const tenant = issuer.pathname.match(/^\/([^/]+)\/v2\.0\/?$/)?.[1];

  if (connection.appIdentityType === "entra" && !z.uuid().safeParse(tenant).success)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Entra app claims require a tenant-specific Entra issuer",
    });

  return companyIdentity.parse({
    scopes: configuration.scopes,
    provider:
      connection.appIdentityType === "entra"
        ? { type: "entra", authority: issuer.origin, tenantId: tenant, label: "Microsoft Entra" }
        : {
            type: "oidc",
            issuer: connection.issuer,
            label: "Company SSO",
            nameClaim: configuration.mapping.name,
            emailClaim: configuration.mapping.email,
            groupsClaim: configuration.mapping.extraFields.groups,
          },
    management: { clientId: configuration.clientId, clientSecret: configuration.clientSecret },
    directory: null,
  });
};

export const saveSsoProvider = async (
  database: DatabaseExecutor,
  organizationId: string,
  input: z.infer<typeof oidcProviderInput> | null,
  credential: OrganizationCredential,
) => {
  const existing = await readSsoProvider(database, organizationId);

  if (!input) {
    if (existing)
      await credential.auth.api.deleteSSOProvider({
        headers: credential.headers,
        body: { providerId: existing.providerId },
      });

    return;
  }

  if (existing && input.providerId !== existing.providerId)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "Remove the current SSO connection before registering another provider",
    });

  if (existing)
    await credential.auth.api.updateSSOProvider({
      headers: credential.headers,
      body: input,
    });
  else
    await credential.auth.api.registerSSOProvider({
      headers: credential.headers,
      body: { ...input, organizationId },
    });
};
