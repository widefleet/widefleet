import { form, query } from "$app/server";
import { error, invalid } from "@sveltejs/kit";
import {
  appAccessChange,
  appAccessGroups,
  appPath,
  groupSearch,
  organizationSelection,
} from "@platform/contracts";
import { z } from "zod";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

const appTarget = appPath.extend(organizationSelection.shape);

export const getAppAccess = query(appTarget, async ({ appId, organizationId }) => {
  const { runtime, principal } = await remoteContext({ organizationId });

  return queryValue(await runtime.appAccess.read(principal, appId));
});

export const changeAppAccess = form(
  appTarget.extend({
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
  async ({ appId, revision, groups, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.appAccess.change(principal, appId, { revision, groups }));
    await getAppAccess({ appId, organizationId }).refresh();

    return { saved: true };
  },
);

export const searchAccessGroups = form(
  appTarget.extend({ id: z.string().max(300).optional(), query: groupSearch.shape.query }),
  async ({ appId, query, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    const access = queryValue(await runtime.appAccess.read(principal, appId));

    if (!access.canManage) error(403, "Only owners and admins can select access groups.");
    const result = await runtime.directory.search(principal, groupSearch.parse({ query }));

    if (result.isErr()) invalid(result.error.message);

    return result.value;
  },
);
