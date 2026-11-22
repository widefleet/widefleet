import { query, getRequestEvent } from "$app/server";
import { organizationSelection } from "@platform/contracts";
import { remoteContext } from "#server/remote-support";
import { readCompanyAccount } from "#server/settings-account";

export const getCompanyAccount = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return readCompanyAccount(runtime, principal, getRequestEvent().locals.session);
});
