import { form, getRequestEvent, query } from "$app/server";
import { error, invalid, redirect } from "@sveltejs/kit";
import { appAccessChange, appPath, groupSearch } from "@platform/contracts";
import { z } from "zod";
import { getAppDetails } from "./apps.remote.ts";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

export const getAppAccess = query(appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.appAccess.read(principal, appId));
});

export const changeAppAccess = form(
  appPath.extend({
    id: z.string().max(300).optional(),
    revision: appAccessChange.shape.revision,
    search: z.string().max(200).default(""),
    allAuthenticated: z.boolean().default(false),
  }),
  async ({ appId, revision, allAuthenticated, search }) => {
    const { runtime, principal } = await remoteContext(true);
    formValue(await runtime.appAccess.change(principal, appId, { revision, allAuthenticated }));
    await getAppAccess({ appId }).refresh();
    await getAppDetails({ appId, search }).refresh();

    if (!getRequestEvent().isRemoteRequest)
      redirect(303, `/apps/${appId}?tab=access&scope=app&accessSaved=1#app-access`);

    return { saved: true };
  },
);

export const searchAccessGroups = form(
  appPath.extend({ id: z.string().max(300).optional(), query: groupSearch.shape.query }),
  async ({ appId, query }) => {
    const { runtime, principal } = await remoteContext();
    const access = queryValue(await runtime.appAccess.read(principal, appId));

    if (!access.canManage) error(403, "Only owners and admins can select access groups.");
    const result = await runtime.directory.search(principal, groupSearch.parse({ query }));

    if (result.isErr()) invalid(result.error.message);

    return result.value;
  },
);
