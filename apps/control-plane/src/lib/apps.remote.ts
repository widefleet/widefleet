import { form, getRequestEvent, query } from "$app/server";
import { redirect } from "@sveltejs/kit";
import {
  appPath,
  createAgentInput,
  createAppInput,
  identifier,
  organizationSelection,
  rollbackInput,
} from "@platform/contracts";
import { z } from "zod";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

const appQuery = appPath.extend({ search: z.string().trim().max(200).default("") });

export const getApps = query(async () => {
  const { runtime, principal } = await remoteContext();

  return { principal, apps: queryValue(await runtime.apps.list(principal)) };
});

export const getAppDetails = query(appQuery, async ({ appId, search }) => {
  const { runtime, principal } = await remoteContext();
  const app = queryValue(await runtime.apps.get(principal, appId));
  const history = queryValue(await runtime.apps.history(principal, appId));
  const access = queryValue(await runtime.apps.access(principal, appId, search));

  return { app, history, access };
});

export const createApp = form(
  createAppInput.extend({
    ...organizationSelection.shape,
    parentId: z
      .union([identifier, z.literal("")])
      .optional()
      .transform((value) => value || null),
  }),
  async ({ organizationId, ...input }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    const app = formValue(await runtime.apps.create(principal, input));
    await getApps().refresh();
    redirect(303, `/apps/${app.id}`);
  },
);

export const registerAgent = form(
  createAgentInput.extend(organizationSelection.shape),
  async ({ organizationId, ...input }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    const result = formValue(await runtime.agents.create(principal, input));

    return { agentToken: result.token, agentName: result.agent.name };
  },
);

const accessInput = appQuery.extend({
  ...organizationSelection.shape,
  id: z.string().max(300).optional(),
  userId: z.string().min(1).max(128),
});

const refreshAccess = async (appId: string, search: string) => {
  await getAppDetails({ appId, search }).refresh();

  if (!getRequestEvent().isRemoteRequest)
    redirect(
      303,
      `/apps/${appId}/access/management?${new URLSearchParams({ q: search, saved: "1" })}#access`,
    );

  return { saved: true };
};

export const grantAccess = form(accessInput, async ({ appId, userId, search, organizationId }) => {
  const { runtime, principal } = await remoteContext({ organizationId });
  formValue(await runtime.apps.grant(principal, appId, userId));

  return refreshAccess(appId, search);
});

export const revokeAccess = form(accessInput, async ({ appId, userId, search, organizationId }) => {
  const { runtime, principal } = await remoteContext({ organizationId });
  formValue(await runtime.apps.revoke(principal, appId, userId));

  return refreshAccess(appId, search);
});

export const rollbackApp = form(
  appQuery.extend({
    ...organizationSelection.shape,
    ...rollbackInput.shape,
    id: identifier.optional(),
    requestId: identifier,
  }),
  async ({ appId, artifactId, requestId, search, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.apps.rollback(principal, appId, artifactId, requestId));
    await getAppDetails({ appId, search }).refresh();

    if (!getRequestEvent().isRemoteRequest) redirect(303, `/apps/${appId}/deployments`);

    return { accepted: true };
  },
);

export const removeApp = form(
  appPath.extend({
    ...organizationSelection.shape,
    confirmed: z
      .boolean()
      .optional()
      .refine((value) => value === true, "Please confirm permanent deletion."),
  }),
  async ({ appId, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.apps.remove(principal, appId));
    await getApps().refresh();
    redirect(303, "/");
  },
);
