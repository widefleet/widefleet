import { command, query } from "$app/server";
import { runtimeRelease, runtimeUpdate } from "@platform/contracts";
import { remoteContext, queryValue } from "#server/remote-support";

export const getRuntimeStatus = query(async () => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.releases.read(principal));
});

export const installRuntime = command(runtimeRelease, async (release) => {
  const { runtime, principal } = await remoteContext(true);
  const status = queryValue(await runtime.releases.install(principal, release));
  await getRuntimeStatus().refresh();

  return status;
});

export const rollbackRuntime = command(runtimeUpdate, async (input) => {
  const { runtime, principal } = await remoteContext(true);
  const status = queryValue(await runtime.releases.rollback(principal, input));
  await getRuntimeStatus().refresh();

  return status;
});
