import type { OAuthClaimExtensionInput } from "@better-auth/oauth-provider";
import { readAuthenticationReference } from "./authentication-context.ts";
import { APIError } from "better-auth/api";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { organizationIdentifier } from "@platform/contracts";
import type { OrganizationAccess } from "./application-context.ts";
import type { DatabaseExecutor } from "./database.ts";
import { organizationSettings } from "./schema.ts";
import { invitation, member, user, ssoProvider } from "./auth-schema.ts";
import { installationOrganizationId } from "../organization.ts";
import { InvalidOperation } from "./errors.ts";

export const createAuthenticationAdmission = (
  database: DatabaseExecutor,
  access: OrganizationAccess = { filterOrganizations: async () => [installationOrganizationId] },
) => ({
  signInProvider: async (email: string) => {
    const domain = email.trim().toLowerCase().split("@")[1];

    if (!domain) return null;

    const candidates = await database
      .select({ id: ssoProvider.organizationId, providerId: ssoProvider.providerId })
      .from(ssoProvider)
      .where(and(eq(ssoProvider.domain, domain), eq(ssoProvider.domainVerified, true)));

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

    if (
      !current?.emailVerified ||
      (authority.organizationId !== null && authority.organizationId !== organizationId) ||
      !(await access.filterOrganizations([{ id: organizationId }])).includes(organizationId) ||
      (
        await database
          .select({ verified: ssoProvider.domainVerified })
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
