import type { PageServerLoad } from "./$types";
import { invitationPath } from "@platform/contracts";
import { getRuntime } from "#server/runtime";
import { invitationIdentity } from "#server/page-auth";
import { remoteOperation } from "#server/remote-support";

export const load: PageServerLoad = async ({ params, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const runtime = await getRuntime();
  const { invitationId } = invitationPath.parse(params);
  const person = await invitationIdentity(invitationId);

  const invitation = await remoteOperation(() => runtime.invitations.read(person, invitationId));

  return { invitation };
};
