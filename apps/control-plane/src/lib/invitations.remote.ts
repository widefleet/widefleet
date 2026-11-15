import { form, getRequestEvent } from "$app/server";
import { redirect } from "@sveltejs/kit";
import { invitationAcceptance } from "@platform/contracts";
import { getRuntime } from "#server/runtime";
import { pageFailure, invitationIdentity } from "#server/page-auth";
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

  const selected = await runtime.identity.selectOrganization(request, result.organizationId);

  if (selected.isErr()) pageFailure(selected.error);
  redirect(303, "/");
});
