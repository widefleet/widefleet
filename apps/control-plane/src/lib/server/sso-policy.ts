import { eq, sql } from "drizzle-orm";
import { installationOrganizationId } from "../organization.ts";
import type { Configuration } from "./config.ts";
import { ssoProvider } from "./auth-schema.ts";

type ConfigurationPolicy = Pick<
  Configuration,
  | "ARTIFACT_STORAGE_PROVIDER"
  | "PLATFORM_SSO_TRUST_PROVIDER"
  | "PLATFORM_SSO_ALLOW_EMAIL_ACCOUNT_LINKING"
>;

// Only the deployment operator can grant this trust, and only to the local
// installation. Hosted organizations always establish ownership through DNS.
export const operatorTrustedSso = (
  configuration: ConfigurationPolicy | undefined,
  organizationId = installationOrganizationId,
) =>
  configuration?.ARTIFACT_STORAGE_PROVIDER !== "r2" &&
  configuration?.PLATFORM_SSO_TRUST_PROVIDER === true &&
  organizationId === installationOrganizationId;

export const companySsoAvailable = (
  configuration: ConfigurationPolicy | undefined,
  provider: { organizationId: string; domainVerified: boolean } | null | undefined,
) =>
  Boolean(
    provider &&
    (provider.domainVerified || operatorTrustedSso(configuration, provider.organizationId)),
  );

export const companySsoAvailableSql = (configuration: ConfigurationPolicy | undefined) =>
  operatorTrustedSso(configuration)
    ? sql<boolean>`(${ssoProvider.domainVerified} OR ${ssoProvider.organizationId} = ${installationOrganizationId})`
    : eq(ssoProvider.domainVerified, true);

export const ssoPolicy = (configuration: ConfigurationPolicy, organizationId: string) => ({
  domainVerificationRequired: !operatorTrustedSso(configuration, organizationId),
  allowEmailAccountLinking:
    operatorTrustedSso(configuration, organizationId) &&
    configuration.PLATFORM_SSO_ALLOW_EMAIL_ACCOUNT_LINKING,
});
