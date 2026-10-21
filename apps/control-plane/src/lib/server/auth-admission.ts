import type { OAuthClaimExtensionInput } from "@better-auth/oauth-provider";
import { readAuthenticationReference } from "./authentication-context.ts";
import { APIError } from "better-auth/api";
import { and, eq, gt } from "drizzle-orm";
import type { OrganizationAccess } from "./application-context.ts";
import type { DatabaseExecutor } from "./database.ts";
import { invitation, member, user } from "./auth-schema.ts";
import { installationOrganizationId } from "../organization.ts";

export const createAuthenticationAdmission = (
  database: DatabaseExecutor,
  access: OrganizationAccess = { filterOrganizations: async () => [installationOrganizationId] },
) => ({
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
  tokenClaims: async ({ user: subject, referenceId }: OAuthClaimExtensionInput) => {
    const authority = subject ? readAuthenticationReference(subject.id, referenceId) : null;

    if (!subject || !authority || !referenceId)
      throw new APIError("UNAUTHORIZED", {
        message: "This authorization has no valid sign-in context; sign in again",
      });

    return { reference_id: referenceId };
  },
});
