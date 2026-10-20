import { form, getRequestEvent, query } from "$app/server";
import { redirect } from "@sveltejs/kit";
import { appPath, organizationSelection } from "@platform/contracts";
import { z } from "zod";
import { getAppDetails } from "#lib/apps.remote";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

export const getCatalog = query(async () => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.apps.catalog(principal));
});

export const setCatalogListing = form(
  appPath.extend({
    ...organizationSelection.shape,
    listed: z.enum(["true", "false"]),
    search: z.string().trim().max(200).default(""),
  }),
  async ({ appId, listed, search, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.apps.setCatalogListing(principal, appId, listed === "true"));
    await getAppDetails({ appId, search }).refresh();
    await getCatalog().refresh();

    if (!getRequestEvent().isRemoteRequest)
      redirect(303, `/apps/${appId}/settings?${new URLSearchParams({ q: search })}#catalog`);

    return { saved: true };
  },
);
