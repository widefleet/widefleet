import { query } from "$app/server";
import * as contract from "@platform/contracts";
import { queryValue, remoteContext } from "#server/remote-support";

export const getAppConnections = query(contract.appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.connections.connections(principal, appId));
});
