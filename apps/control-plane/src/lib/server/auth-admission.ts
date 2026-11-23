import {
  companySignInLimit,
  companySsoAvailableSql,
  operatorTrustedSso,
  type SignIn,
} from "./sso-policy.ts";
import type { OAuthClaimExtensionInput } from "@better-auth/oauth-provider";
import { readAuthenticationReference } from "./authentication-context.ts";
import type { Configuration } from "./config.ts";
import { APIError } from "better-auth/api";
import { and, eq, exists, gt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { organizationIdentifier } from "@platform/contracts";
import type { OrganizationAccess } from "./application-context.ts";
import type { DatabaseExecutor } from "./database.ts";
import { organizationSettings, ssoDomains } from "./schema.ts";
import { invitation, member, user, ssoProvider } from "./auth-schema.ts";
import { installationOrganizationId } from "../organization.ts";
import { InvalidOperation } from "./errors.ts";
import { readInstallation } from "./installation-store.ts";

export const createAuthenticationAdmission = (
  database: DatabaseExecutor,
  access: OrganizationAccess = { filterOrganizations: async () => [installationOrganizationId] },
  publicSignup = false,
  configuration?: Configuration,
) => ({
  signInProvider: async (email: string) => {
    const domain = email.trim().toLowerCase().split("@")[1];

    if (!domain) return null;

    const candidates = await database
      .select({ id: ssoProvider.organizationId, providerId: ssoProvider.providerId })
      .from(ssoProvider)
      .where(
        and(
          companySsoAvailableSql(configuration),
          or(
            // Better Auth mirrors verified domains once any DNS proof exists.
            sql`${domain} = any(string_to_array(${ssoProvider.domain}, ','))`,
            operatorTrustedSso(configuration)
              ? and(
                  eq(ssoProvider.organizationId, installationOrganizationId),
                  exists(
                    database
                      .select()
                      .from(ssoDomains)
                      .where(
                        and(
                          eq(ssoDomains.organizationId, ssoProvider.organizationId),
                          eq(ssoDomains.domain, domain),
                        ),
                      ),
                  ),
                )
              : undefined,
          ),
        ),
      );

    const allowed = new Set(await access.filterOrganizations(candidates));
    const providers = candidates.filter((candidate) => allowed.has(candidate.id));

    if (providers.length > 1)
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "Use the sign-in link provided by your organization.",
      });

    return providers[0]?.providerId ?? null;
  },
  allowEmail: async (email: string) => {
    if (publicSignup && (await readInstallation(database)).ownerId) return true;

    const memberships = await database
      .select({ id: member.organizationId })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.email, email));

    const invitations = await database
      .select({ id: invitation.organizationId })
      .from(invitation)
      .where(
        and(
          eq(invitation.email, email),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      );

    const candidates = [...memberships, ...invitations];
    const allowed = new Set(await access.filterOrganizations(candidates));

    return candidates.some((candidate) => allowed.has(candidate.id));
  },
  signInLimit: (signIn: SignIn) => companySignInLimit(database, signIn),
  tokenClaims: async ({ user: subject, metadata, referenceId }: OAuthClaimExtensionInput) => {
    const authority = subject ? readAuthenticationReference(subject.id, referenceId) : null;

    if (!subject || !authority || !referenceId)
      throw new APIError("UNAUTHORIZED", {
        message: "This authorization has no valid sign-in context; sign in again",
      });
    const userId = subject.id;

    const client = z
      .object({ purpose: z.literal("app-login"), organizationId: organizationIdentifier })
      .safeParse(metadata);

    if (!client.success) return { reference_id: referenceId };
    const organizationId = client.data.organizationId;

    const [current] = await database
      .select({ emailVerified: user.emailVerified })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)));

    // Recovery cannot authorize long-lived access, so a reference never comes from it.
    const limit = await companySignInLimit(database, {
      userId,
      identityOrganizationId: authority.organizationId,
      recovery: false,
    });

    if (
      !current?.emailVerified ||
      (limit !== null && limit !== organizationId) ||
      !(await access.filterOrganizations([{ id: organizationId }])).includes(organizationId) ||
      (
        await database
          .select({ verified: companySsoAvailableSql(configuration) })
          .from(ssoProvider)
          .innerJoin(
            organizationSettings,
            eq(organizationSettings.organizationId, ssoProvider.organizationId),
          )
          .where(
            and(
              eq(ssoProvider.organizationId, organizationId),
              eq(organizationSettings.ssoRequired, true),
            ),
          )
      )[0]?.verified === true
    )
      throw new APIError("FORBIDDEN", {
        message: "This account cannot sign in to this organization's apps through Widefleet",
      });

    return { reference_id: referenceId, organization_id: organizationId };
  },
});
