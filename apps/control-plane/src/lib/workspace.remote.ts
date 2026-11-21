import { query } from "$app/server";
import { getUserSession } from "#server/page-auth";
import { remoteContext, queryValue } from "#server/remote-support";

// The workspace navigation shows the member's role and the organizations they can switch to.
export const getWorkspace = query(async () => {
  const { runtime, principal } = await remoteContext();
  const { user, session } = getUserSession();

  const organizations = queryValue(
    await runtime.identity.listOrganizations(user.id, session.identityOrganizationId ?? null),
  );

  return { principal, organizations };
});
