import { form, getRequestEvent, query } from "$app/server";
import { redirect } from "@sveltejs/kit";
import {
  appPath,
  createAgentInput,
  createAppInput,
  identifier,
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
  const roles = queryValue(await runtime.appAccess.roles(principal, appId));

  const candidates =
    roles.actions.includes("roles") && search
      ? queryValue(await runtime.appAccess.candidates(principal, appId, search))
      : [];

  return { app, history, roles, candidates };
});

export const createApp = form(
  createAppInput.extend({
    parentId: z
      .union([identifier, z.literal("")])
      .optional()
      .transform((value) => value || null),
  }),
  async (input) => {
    const { runtime, principal } = await remoteContext(true);
    const app = formValue(await runtime.apps.create(principal, input));
    await getApps().refresh();
    redirect(303, `/apps/${app.id}`);
  },
);

export const registerAgent = form(createAgentInput, async (input) => {
  const { runtime, principal } = await remoteContext(true);
  const result = formValue(await runtime.agents.create(principal, input));

  return { agentToken: result.token, agentName: result.agent.name };
});

export const rollbackApp = form(
  appQuery.extend({ ...rollbackInput.shape, id: identifier.optional(), requestId: identifier }),
  async ({ appId, artifactId, requestId, search }) => {
    const { runtime, principal } = await remoteContext(true);
    formValue(await runtime.apps.rollback(principal, appId, artifactId, requestId));
    await getAppDetails({ appId, search }).refresh();

    if (!getRequestEvent().isRemoteRequest) redirect(303, `/apps/${appId}?tab=deployments`);

    return { accepted: true };
  },
);

export const removeApp = form(
  appPath.extend({
    confirmed: z
      .boolean()
      .optional()
      .refine((value) => value === true, "Please confirm permanent deletion."),
  }),
  async ({ appId }) => {
    const { runtime, principal } = await remoteContext(true);
    formValue(await runtime.apps.remove(principal, appId));
    await getApps().refresh();
    redirect(303, "/");
  },
);
