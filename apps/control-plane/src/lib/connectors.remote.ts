import { query } from "$app/server";
import { appPath, connectorLogQuery } from "@platform/contracts";
import { queryValue, remoteContext } from "#server/remote-support";
import { pageFailure } from "#server/page-auth";

export const getConnectorLogs = query(connectorLogQuery, async (input) => {
  const { runtime, principal } = await remoteContext();
  const result = await runtime.telemetry.queryConnector(principal, input);

  if (result.isErr()) {
    if (result.error._tag === "InvalidOperation") pageFailure(result.error);

    return { page: null, message: result.error.message };
  }

  return { page: result.value, message: null };
});

export const getConnectorCatalog = query(async () => {
  const { runtime } = await remoteContext();

  return queryValue(await runtime.connectors.catalog());
});

export const getAppConnections = query(appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.connectors.connections(principal, appId));
});
