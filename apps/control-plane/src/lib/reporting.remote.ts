import { command, query } from "$app/server";
import { reportingPreferences } from "@platform/contracts";
import { remoteContext, remoteOperation } from "#server/remote-support";
import { getSettings } from "./settings.remote.ts";

export const updateReporting = command(reportingPreferences, async (input) => {
  const { runtime, principal } = await remoteContext(true);
  const status = await remoteOperation(() => runtime.reporting.update(principal, input));
  await getSettings().refresh();

  return status;
});

export const getReportingPreview = query(async () => {
  const { runtime, principal } = await remoteContext();

  return remoteOperation(() => runtime.reporting.preview(principal));
});
