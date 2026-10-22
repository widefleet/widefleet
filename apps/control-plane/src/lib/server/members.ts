import { and, eq, gt } from "drizzle-orm";
import { Result } from "better-result";
import { invitationEntry, invitationInput, memberRoleInput } from "@platform/contracts";
import type { z } from "zod";
import { installationOrganizationId, organizationRole } from "../organization.ts";
import { organizationSettings } from "./schema.ts";
import { invitation, member, organization, ssoProvider, user } from "./auth-schema.ts";
import type { OrganizationAccess } from "./application-context.ts";
import type { Configuration } from "./config.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import { DatabaseUnavailable, InvalidOperation } from "./errors.ts";
import type { AuthenticatedUser, Principal } from "./identity.ts";
import type { SendEmail } from "./email.ts";
import { findMembers } from "./member-directory.ts";
import { organizationOperation, type OrganizationCredential } from "./organization-operations.ts";

export { memberRoleInput } from "@platform/contracts";

const requireAdmin = (principal: Principal) => {
  if (!principal.application.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Only organization owners and admins can manage members.",
    });
};

export const listMembers = async (
  database: Database,
  principal: Principal,
  search: string,
  page: number,
) => {
  requireAdmin(principal);

  return Result.tryPromise({
    try: async () => {
      const members = await findMembers(
        database,
        principal.application.organizationId,
        search,
        (page - 1) * 50,
      );

      return {
        members: members
          .slice(0, 50)
          .map((person) => ({ ...person, role: organizationRole.parse(person.role) })),
        hasNext: members.length > 50,
      };
    },
    catch: (cause) =>
      new DatabaseUnavailable({ message: "Members are temporarily unavailable.", cause }),
  });
};

const changeMembership = (
  principal: Principal,
  memberId: string,
  role: z.infer<typeof organizationRole> | null,
  credential: OrganizationCredential,
) =>
  Result.tryPromise({
    try: async () => {
      const organizationId = principal.application.organizationId;
      await organizationOperation(credential, async (api, headers) => {
        if (role === null)
          await api.removeMember({ headers, body: { memberIdOrEmail: memberId, organizationId } });
        else await api.updateMemberRole({ headers, body: { memberId, role, organizationId } });
      });

      return { changed: true };
    },
    catch: (cause) =>
      cause instanceof InvalidOperation
        ? cause
        : new DatabaseUnavailable({ message: "Could not change organization membership", cause }),
  });

export const changeMemberRole = (
  principal: Principal,
  input: z.infer<typeof memberRoleInput>,
  credential: OrganizationCredential,
) => {
  const parsed = memberRoleInput.parse(input);

  return changeMembership(principal, parsed.memberId, parsed.role, credential);
};

export const removeMember = (
  principal: Principal,
  memberId: string,
  credential: OrganizationCredential,
) => changeMembership(principal, memberId, null, credential);

// Operator provisioning can invite the first owner before an organization has members.
export const prepareOrganizationInvitation = async (
  database: DatabaseExecutor,
  organizationId: string,
  inviterId: string,
  input: z.infer<typeof invitationInput>,
) => {
  const parsed = invitationInput.parse(input);

  const [target] = await database
    .select()
    .from(organization)
    .where(eq(organization.id, organizationId));

  if (!target) throw new InvalidOperation({ code: "NOT_FOUND", message: "Organization not found" });

  const [existing] = await database
    .select({ id: member.id })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, organizationId), eq(user.email, parsed.email)));

  if (existing)
    throw new InvalidOperation({ code: "CONFLICT", message: "This person is already a member" });

  const [created] = await database
    .insert(invitation)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      inviterId,
      email: parsed.email,
      role: parsed.role,
      status: "pending",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    })
    .returning();

  if (!created) throw new Error("Invitation was not created");

  return { invitation: created, organizationName: target.name };
};

const presentInvitation = (record: typeof invitation.$inferSelect) =>
  invitationEntry.parse({
    ...record,
    status:
      record.status === "pending" && record.expiresAt <= new Date() ? "expired" : record.status,
    expiresAt: record.expiresAt.toISOString(),
  });

export const createInvitationService = (
  database: Database,
  configuration: Configuration,
  sendEmail?: SendEmail,
  access: OrganizationAccess = { filterOrganizations: async () => [installationOrganizationId] },
) => {
  const admitted = async (organizationId: string) => {
    if (!(await access.filterOrganizations([{ id: organizationId }])).includes(organizationId))
      throw new InvalidOperation({
        code: "FORBIDDEN",
        message: "This organization is unavailable",
      });
  };

  const send = async (prepared: Awaited<ReturnType<typeof prepareOrganizationInvitation>>) => {
    if (!sendEmail)
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "Invitation email is not configured",
      });
    await sendEmail({
      to: prepared.invitation.email,
      subject: `Invitation to ${prepared.organizationName}`,
      text: `You have been invited to ${prepared.organizationName} on Widefleet.\n\nAccept your invitation: ${configuration.PLATFORM_URL}/invitations/${prepared.invitation.id}\n\nThis invitation expires in 48 hours. If you were not expecting it, you can ignore this email.`,
    });

    return presentInvitation(prepared.invitation);
  };

  return {
    enabled: Boolean(sendEmail),
    send,
    companySignIn: async (invitationId: string) => {
      // A pending invitation link may select its company login before authentication.
      // Recipient details and acceptance still require the matching verified identity.
      const [target] = await database
        .select({ id: organization.id, slug: organization.slug })
        .from(invitation)
        .innerJoin(organization, eq(organization.id, invitation.organizationId))
        .innerJoin(ssoProvider, eq(ssoProvider.organizationId, organization.id))
        .innerJoin(organizationSettings, eq(organizationSettings.organizationId, organization.id))
        .where(
          and(
            eq(invitation.id, invitationId),
            eq(invitation.status, "pending"),
            gt(invitation.expiresAt, new Date()),
            eq(ssoProvider.domainVerified, true),
            eq(organizationSettings.ssoRequired, true),
          ),
        );

      return target && (await access.filterOrganizations([target])).includes(target.id)
        ? target
        : null;
    },
    list: async (principal: Principal) => {
      requireAdmin(principal);

      const records = await database
        .select()
        .from(invitation)
        .where(eq(invitation.organizationId, principal.application.organizationId))
        .orderBy(invitation.createdAt);

      return records.map(presentInvitation);
    },
    invite: async (
      principal: Principal,
      input: z.infer<typeof invitationInput>,
      credential: OrganizationCredential,
    ) => {
      if (!sendEmail)
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "Invitation email is not configured",
        });
      const parsed = invitationInput.parse(input);

      const created = await organizationOperation(credential, (api, headers) =>
        api.createInvitation({
          headers,
          body: { ...parsed, organizationId: principal.application.organizationId },
        }),
      );

      const [target] = await database
        .select()
        .from(organization)
        .where(eq(organization.id, created.organizationId));

      if (!target) throw new Error("Organization not found");

      return send({ invitation: created, organizationName: target.name });
    },
    cancel: async (
      principal: Principal,
      invitationId: string,
      credential: OrganizationCredential,
    ) => {
      const [target] = await database
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          and(
            eq(invitation.id, invitationId),
            eq(invitation.organizationId, principal.application.organizationId),
          ),
        );

      if (!target)
        throw new InvalidOperation({ code: "NOT_FOUND", message: "Invitation not found" });
      await organizationOperation(credential, (api, headers) =>
        api.cancelInvitation({ headers, body: { invitationId } }),
      );

      return { canceled: true };
    },
    read: async (
      actor: Pick<AuthenticatedUser, "userId" | "identityOrganizationId">,
      invitationId: string,
    ) => {
      const { userId } = actor;

      const [record] = await database
        .select({
          invitation,
          organizationName: organization.name,
          email: user.email,
          verified: user.emailVerified,
        })
        .from(invitation)
        .innerJoin(organization, eq(organization.id, invitation.organizationId))
        .innerJoin(user, eq(user.id, userId))
        .where(eq(invitation.id, invitationId));

      if (!record?.verified || record.email.toLowerCase() !== record.invitation.email)
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message: "Sign in with the verified email address that received this invitation",
        });

      if (
        actor.identityOrganizationId !== null &&
        actor.identityOrganizationId !== record.invitation.organizationId
      )
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message: "This company sign-in cannot access another organization's invitation",
        });
      await admitted(record.invitation.organizationId);

      return {
        ...presentInvitation(record.invitation),
        organizationId: record.invitation.organizationId,
        organizationName: record.organizationName,
      };
    },
    accept: async (invitationId: string, credential: OrganizationCredential) => {
      const accepted = await organizationOperation(credential, (api, headers) =>
        api.acceptInvitation({ headers, body: { invitationId } }),
      );

      return { organizationId: accepted.member.organizationId };
    },
  };
};
