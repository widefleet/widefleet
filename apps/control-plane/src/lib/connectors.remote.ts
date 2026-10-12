import { query } from "$app/server";
import { appPath } from "@platform/contracts";
import { queryValue, remoteContext } from "#server/remote-support";

export const getConnectorCatalog = query(async () => {
  const { runtime } = await remoteContext();

  return queryValue(await runtime.connectors.catalog());
});

export const getAppConnections = query(appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.connectors.connections(principal, appId));
});
