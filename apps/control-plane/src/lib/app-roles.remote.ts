import { form, getRequestEvent } from "$app/server";
import { redirect } from "@sveltejs/kit";
import { appPath, appPrincipal, appRoleGrant, appRoleRevoke } from "@platform/contracts";
import { z } from "zod";
import { formValue, remoteContext } from "#server/remote-support";
import { getAppDetails, getApps } from "./apps.remote.ts";
import { getAppAccess } from "./app-access.remote.ts";

const target = appPath.extend({
  ...appPrincipal.shape,
  revision: appRoleGrant.shape.revision,
  search: z.string().max(200).default(""),
  id: z.string().max(300).optional(),
});

const refresh = async (appId: string, search: string) => {
  await getAppDetails({ appId, search }).refresh();
  await getAppAccess({ appId }).refresh();

  if (!getRequestEvent().isRemoteRequest)
    redirect(303, `/apps/${appId}?${new URLSearchParams({ q: search, saved: "1" })}#access`);

  return { saved: true };
};

export const grantAppRole = form(
  target.extend({ role: appRoleGrant.shape.role }),
  async ({ appId, search, type, provider, subject, role, revision }) => {
    const { runtime, principal } = await remoteContext(true);
    formValue(
      await runtime.appAccess.grant(principal, appId, {
        principal: { type, provider, subject },
        role,
        revision,
      }),
    );

    return refresh(appId, search);
  },
);

export const revokeAppRole = form(
  appPath.extend({
    ...appRoleRevoke.shape,
    search: z.string().max(200).default(""),
    id: z.string().max(300).optional(),
  }),
  async ({ appId, search, assignmentId, revision }) => {
    const { runtime, principal } = await remoteContext(true);

    const state = formValue(
      await runtime.appAccess.revoke(principal, appId, { assignmentId, revision }),
    );

    await getApps().refresh();

    if (!state.actions.includes("read")) redirect(303, "/");

    return refresh(appId, search);
  },
);

export const transferAppOwnership = form(
  target,
  async ({ appId, type, provider, subject, revision }) => {
    const { runtime, principal } = await remoteContext(true);
    formValue(
      await runtime.appAccess.transfer(principal, appId, {
        principal: { type, provider, subject },
        revision,
      }),
    );
    await getApps().refresh();
    redirect(303, "/");
  },
);
