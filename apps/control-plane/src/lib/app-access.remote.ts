import { form, getRequestEvent, query } from "$app/server";
import { error, invalid, redirect } from "@sveltejs/kit";
import { appAccessChange, appAccessGroups, appPath, groupSearch } from "@platform/contracts";
import { z } from "zod";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

export const getAppAccess = query(appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.appAccess.read(principal, appId));
});

export const changeAppAccess = form(
  appPath.extend({
    id: z.string().max(300).optional(),
    revision: appAccessChange.shape.revision,
    groups: z
      .string()
      .max(26_000)
      .transform((value) =>
        value
          .split(/\r?\n/)
          .map((group) => group.trim())
          .filter(Boolean),
      )
      .pipe(appAccessGroups),
  }),
  async ({ appId, revision, groups }) => {
    const { runtime, principal } = await remoteContext(true);
    formValue(await runtime.appAccess.change(principal, appId, { revision, groups }));
    await getAppAccess({ appId }).refresh();

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
