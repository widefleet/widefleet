import { form, getRequestEvent } from "$app/server";
import { redirect } from "@sveltejs/kit";
import { invitationAcceptance } from "@platform/contracts";
import { getRuntime } from "#server/runtime";
import { invitationIdentity } from "#server/page-auth";
import { readOrganizationSlug } from "#server/organization";
import { workspacePath } from "#lib/workspace-path";
import { remoteOperation } from "#server/remote-support";

export const acceptInvitation = form(invitationAcceptance, async ({ invitationId }) => {
  const { request } = getRequestEvent();
  const runtime = await getRuntime();
  await invitationIdentity(invitationId);

  const result = await remoteOperation(() =>
    runtime.invitations.accept(invitationId, {
      auth: runtime.auth,
      headers: request.headers,
    }),
  );

  const slug = await readOrganizationSlug(runtime.database.db, result.organizationId);

  redirect(303, workspacePath(slug));
});
