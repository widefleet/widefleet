import { query } from "$app/server";
import * as contract from "@platform/contracts";
import { queryValue, remoteContext } from "#server/remote-support";

export const getAppConnections = query(
  contract.appPath.extend(contract.organizationSelection.shape),
  async ({ appId, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    return queryValue(await runtime.connections.connections(principal, appId));
  },
);
