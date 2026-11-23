import { command, form, query, requested } from "$app/server";
import { redirect } from "@sveltejs/kit";
import {
  organizationSelection,
  memberQuery,
  invitationInput,
  invitationPath,
  memberPath,
} from "@platform/contracts";
import { z } from "zod";
import { changeMemberRole, listMembers, memberRoleInput, removeMember } from "#server/members";
import {
  commandContext,
  formValue,
  queryValue,
  remoteContext,
  remoteOperation,
} from "#server/remote-support";
import { getWorkspace } from "#lib/workspace.remote";
import { workspacePath } from "#lib/workspace-path";

export const getMembers = query(
  memberQuery.extend(organizationSelection.shape),
  async ({ search, page, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    const result = await remoteOperation(() =>
      listMembers(runtime.database.db, principal, search, page),
    );

    return {
      principal,
      ...queryValue(result),
      invitations: await runtime.invitations.list(principal),
      emailEnabled: runtime.invitations.enabled,
    };
  },
);

export const setMemberRole = command(
  memberRoleInput.extend(organizationSelection.shape),
  async ({ memberId, role, organizationId }) => {
    const { runtime, principal, organization, request } = await commandContext({ organizationId });
    queryValue(
      await remoteOperation(() =>
        changeMemberRole(
          principal,
          { memberId, role },
          { auth: runtime.auth, headers: request.headers },
        ),
      ),
    );
    // The page requests its own search and page, which carry the optimistic role.
    await requested(getMembers, 1).refreshAll();
    // A changed own role changes the workspace navigation.
    await getWorkspace({ organization: organization.slug }).refresh();
  },
);

export const inviteMember = form(
  invitationInput.extend({
    ...organizationSelection.shape,
    resend: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  }),
  async ({ organizationId, ...input }) => {
    const { runtime, principal, request } = await remoteContext({ organizationId });
    await remoteOperation(() =>
      runtime.invitations.invite(principal, input, {
        auth: runtime.auth,
        headers: request.headers,
      }),
    );

    return { invited: true };
  },
);

export const cancelInvitation = form(
  invitationPath.extend(organizationSelection.shape),
  async ({ organizationId, invitationId }) => {
    const { runtime, principal, organization, request } = await remoteContext({ organizationId });
    await remoteOperation(() =>
      runtime.invitations.cancel(principal, invitationId, {
        auth: runtime.auth,
        headers: request.headers,
      }),
    );
    redirect(303, workspacePath(organization.slug, "/settings/members"));
  },
);

export const deleteMember = form(
  memberPath.extend(organizationSelection.shape),
  async ({ organizationId, memberId }) => {
    const { runtime, principal, organization, request } = await remoteContext({ organizationId });
    formValue(
      await removeMember(principal, memberId, {
        auth: runtime.auth,
        headers: request.headers,
      }),
    );
    redirect(303, workspacePath(organization.slug, "/settings/members"));
  },
);
