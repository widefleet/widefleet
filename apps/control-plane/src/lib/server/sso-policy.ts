import { eq, sql } from "drizzle-orm";
import { parseCompanyDomains } from "@platform/contracts";
import { installationOrganizationId } from "../organization.ts";
import type { Configuration } from "./config.ts";
import type { DatabaseExecutor } from "./database.ts";
import { ssoProvider, user } from "./auth-schema.ts";

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

// Who signed in, and which organization's company SSO or recovery authenticated it.
export type SignIn = { userId: string; identityOrganizationId: string | null; recovery: boolean };

// A company sign-in reaches only its organization, whose administrators control the
// SSO identities of external guests but not their addresses or other memberships. For an
// address on one of its DNS-verified domains, the organization already controls the
// mailbox and could sign the person in by email code, so that sign-in also reaches the
// person's other memberships. The proof is read on every use: losing it limits existing
// sessions and tokens again. Recovery always stays in its organization.
export const companySignInLimit = async (database: DatabaseExecutor, signIn: SignIn) => {
  if (signIn.identityOrganizationId === null) return null;

  if (signIn.recovery) return signIn.identityOrganizationId;

  const [identity] = await database
    .select({
      email: user.email,
      emailVerified: user.emailVerified,
      domain: ssoProvider.domain,
      domainVerified: ssoProvider.domainVerified,
    })
    .from(user)
    .innerJoin(ssoProvider, eq(ssoProvider.organizationId, signIn.identityOrganizationId))
    .where(eq(user.id, signIn.userId));

  return identity?.emailVerified &&
    identity.domainVerified &&
    parseCompanyDomains(identity.domain).includes(identity.email.toLowerCase().split("@")[1] ?? "")
    ? null
    : signIn.identityOrganizationId;
};
