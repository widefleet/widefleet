import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { oidcProviderInput, parseCompanyDomains } from "@platform/contracts";
import { organizationSettings } from "./schema.ts";
import { ssoProvider } from "./auth-schema.ts";
import { companyIdentity } from "./company-identity.ts";
import type { DatabaseExecutor } from "./database.ts";
import type { SecretEncryption } from "./secret-encryption.ts";
import type { Transaction } from "./transactions.ts";
import type { OrganizationCredential } from "./organization-operations.ts";
import { InvalidOperation } from "./errors.ts";
import { changeSsoDomains } from "./sso-domains.ts";

export const readSsoProvider = async (database: DatabaseExecutor, organizationId: string) => {
  const [record] = await database
    .select({
      provider: ssoProvider,
      required: organizationSettings.ssoRequired,
      domainSsoRequired: organizationSettings.domainSsoRequired,
    })
    .from(ssoProvider)
    .leftJoin(
      organizationSettings,
      eq(organizationSettings.organizationId, ssoProvider.organizationId),
    )
    .where(eq(ssoProvider.organizationId, organizationId));

  return record
    ? {
        ...record.provider,
        required: record.required === true,
        domainSsoRequired: record.domainSsoRequired === true,
      }
    : null;
};

// The runtime reads the native provider. This is a published consumer view, never
// a second editable/persisted SSO connection.
export const readSsoConfiguration = async (
  database: DatabaseExecutor,
  encryption: SecretEncryption,
  organizationId: string,
) => {
  const provider = await readSsoProvider(database, organizationId);

  if (!provider?.oidcConfig) return null;

  const oidcConfig = oidcProviderInput.shape.oidcConfig
    .strip()
    .parse(
      JSON.parse(
        await encryption.decrypt(
          { kind: "sso-provider-config", field: "oidcConfig" },
          provider.oidcConfig,
        ),
      ),
    );

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

  if (
    connection.appIdentityType === "google" &&
    connection.issuer !== "https://accounts.google.com"
  )
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Google Workspace requires https://accounts.google.com as its issuer",
    });

  return companyIdentity.parse({
    scopes: configuration.scopes,
    provider:
      connection.appIdentityType === "entra"
        ? { type: "entra", authority: issuer.origin, tenantId: tenant, label: "Microsoft Entra" }
        : connection.appIdentityType === "google"
          ? { type: "google", domain: connection.domain }
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

// Saves of one organization's SSO connection run one at a time. The update check reads the
// saved provider before DNS lookups and Better Auth merges the update after them, so a save
// stalled in between could otherwise merge a client secret that another save entered. A second
// save fails instead of waiting, because waiting holds pool connections the running save needs.
export const lockSsoChanges = async (transaction: Transaction, organizationId: string) => {
  const result = await transaction.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${JSON.stringify(["sso-provider", organizationId])}, 0)) as locked`,
  );

  if (!z.object({ locked: z.boolean() }).parse(result.rows[0]).locked)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "Another SSO change is still in progress. Try again shortly.",
    });
};

export const saveSsoProvider = async (
  database: DatabaseExecutor,
  organizationId: string,
  input: z.infer<typeof oidcProviderInput> | null,
  credential: OrganizationCredential,
  domainVerificationRequired = true,
) =>
  database.transaction(async (transaction) => {
    await lockSsoChanges(transaction, organizationId);
    const existing = await readSsoProvider(transaction, organizationId);

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

    // Widefleet verifies each domain itself, so Better Auth's provider domain is
    // changed only through the domain list.
    const { domain, ...requested } = input;

    // Microsoft has no picture URL. Sign-in copies the photo from Graph with `User.Read`,
    // which the company sign-in registration already grants for app membership checks.
    const connection =
      requested.appIdentityType === "entra"
        ? {
            ...requested,
            oidcConfig: {
              ...requested.oidcConfig,
              scopes: [...new Set([...requested.oidcConfig.scopes, "User.Read"])],
            },
          }
        : requested;

    if (existing)
      await credential.auth.api.updateSSOProvider({
        headers: credential.headers,
        body: connection,
      });
    else {
      if (!domain && (domainVerificationRequired || connection.appIdentityType === "google"))
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Enter a company email domain",
        });
      await credential.auth.api.registerSSOProvider({
        headers: credential.headers,
        body: { ...connection, domain: domain ?? "", organizationId },
      });
    }

    if (domain === undefined) return;
    await changeSsoDomains(
      transaction,
      organizationId,
      { replace: parseCompanyDomains(domain) },
      domainVerificationRequired,
    );
  });
