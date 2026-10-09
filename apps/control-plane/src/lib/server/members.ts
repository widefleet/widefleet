import { APIError } from "better-auth/api";
import { Result } from "better-result";
import { z } from "zod";
import { installationOrganizationId, organizationRole } from "../organization.ts";
import type { Authentication } from "./auth.ts";
import type { Database } from "./database.ts";
import { DatabaseUnavailable, InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { findMembers } from "./member-directory.ts";

const requireAdmin = (principal: Principal) => {
  if (!principal.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Only owners and admins can manage members.",
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
      const members = await findMembers(database, search, (page - 1) * 50);

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

export const memberRoleInput = z.object({
  memberId: z.string().min(1).max(200),
  role: organizationRole,
});

export const changeMemberRole = async (
  auth: Authentication,
  principal: Principal,
  headers: Headers,
  input: z.infer<typeof memberRoleInput>,
) => {
  requireAdmin(principal);

  return Result.tryPromise({
    try: () =>
      auth.api.updateMemberRole({
        headers,
        body: { ...input, organizationId: installationOrganizationId },
      }),
    catch: (cause) =>
      cause instanceof APIError && cause.statusCode < 500
        ? new InvalidOperation({
            code: "BAD_REQUEST",
            message:
              "Role unchanged. Only owners can appoint or change owners; at least one owner must remain.",
          })
        : new DatabaseUnavailable({
            message: "Could not save the role. Please try again.",
            cause,
          }),
  });
};
