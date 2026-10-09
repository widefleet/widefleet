import { form, getRequestEvent, query } from "$app/server";
import { redirect } from "@sveltejs/kit";
import { appPath } from "@platform/contracts";
import { z } from "zod";
import { getAppDetails } from "#lib/apps.remote";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

export const getCatalog = query(async () => {
  const { runtime } = await remoteContext();

  return queryValue(await runtime.apps.catalog());
});

export const setCatalogListing = form(
  appPath.extend({
    listed: z.enum(["true", "false"]),
    search: z.string().trim().max(200).default(""),
  }),
  async ({ appId, listed, search }) => {
    const { runtime, principal } = await remoteContext(true);
    formValue(await runtime.apps.setCatalogListing(principal, appId, listed === "true"));
    await getAppDetails({ appId, search }).refresh();
    await getCatalog().refresh();

    if (!getRequestEvent().isRemoteRequest)
      redirect(
        303,
        `/apps/${appId}?${new URLSearchParams({ tab: "settings", q: search })}#catalog`,
      );

    return { saved: true };
  },
);
