import { form, getRequestEvent, query } from "$app/server";
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
import { formValue, queryValue, remoteContext, remoteOperation } from "#server/remote-support";
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

export const setMemberRole = form(
  memberRoleInput.extend({
    ...organizationSelection.shape,
    search: memberQuery.shape.search.default(""),
    page: z
      .string()
      .regex(/^[0-9]+$/)
      .default("1")
      .transform(Number)
      .pipe(memberQuery.shape.page.removeDefault()),
  }),
  async ({ memberId, role, search, page, organizationId }) => {
    const { runtime, principal, organization, request } = await remoteContext({ organizationId });
    formValue(
      await remoteOperation(() =>
        changeMemberRole(
          principal,
          { memberId, role },
          { auth: runtime.auth, headers: request.headers },
        ),
      ),
    );
    await getMembers({ search, page, organizationId }).refresh();
    // A changed own role changes the workspace navigation.
    await getWorkspace({ organization: organization.slug }).refresh();

    if (!getRequestEvent().isRemoteRequest)
      redirect(
        303,
        workspacePath(
          organization.slug,
          `/settings/members?${new URLSearchParams({ q: search, page: String(page), saved: "1" })}`,
        ),
      );

    return { saved: true };
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
    const { runtime, principal, organization, request } = await remoteContext({ organizationId });
    await remoteOperation(() =>
      runtime.invitations.invite(principal, input, {
        auth: runtime.auth,
        headers: request.headers,
      }),
    );
    redirect(303, workspacePath(organization.slug, "/settings/members?invited=1"));
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
