import { command, query } from "$app/server";
import { reportingPreferences, organizationSelection } from "@platform/contracts";
import { remoteContext, remoteOperation } from "#server/remote-support";
import { getSettings } from "./settings.remote.ts";

export const updateReporting = command(
  reportingPreferences.extend(organizationSelection.shape),
  async ({ organizationId, ...input }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    const status = await remoteOperation(() => runtime.reporting.update(principal, input));
    await getSettings().refresh();

    return status;
  },
);

export const getReportingPreview = query(async () => {
  const { runtime, principal } = await remoteContext();

  return remoteOperation(() => runtime.reporting.preview(principal));
});
