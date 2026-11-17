import { query, getRequestEvent } from "$app/server";
import { remoteContext } from "#server/remote-support";
import { readCompanyAccount } from "#server/settings-account";

export const getCompanyAccount = query(async () => {
  const { runtime, principal } = await remoteContext();

  return readCompanyAccount(runtime, principal, getRequestEvent().locals.session);
});
