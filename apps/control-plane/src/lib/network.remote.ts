import { command, query } from "$app/server";
import * as contract from "@platform/contracts";
import { commandContext, queryValue, remoteContext } from "#server/remote-support";

const appTarget = contract.appPath.extend(contract.organizationSelection.shape);

export const getAppNetwork = query(appTarget, async ({ appId, organizationId }) => {
  const { runtime, principal } = await remoteContext({ organizationId });

  return queryValue(await runtime.network.view(principal, appId));
});

export const changeAppNetwork = command(
  appTarget.extend(contract.networkChange.shape),
  async ({ appId, organizationId, ...change }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    queryValue(await runtime.network.change(principal, appId, change));
    await getAppNetwork({ appId, organizationId }).refresh();
  },
);

export const retryAppNetwork = command(appTarget, async ({ appId, organizationId }) => {
  const { runtime, principal } = await commandContext({ organizationId });
  queryValue(await runtime.network.change(principal, appId, { action: "retry" }));
  await getAppNetwork({ appId, organizationId }).refresh();
});
