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
import { workspacePath } from "#lib/workspace-path";

const appTarget = appPath.extend(organizationSelection.shape);

const appQuery = appTarget.extend({ search: z.string().trim().max(200).default("") });

export const getApps = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return { principal, apps: queryValue(await runtime.apps.list(principal)) };
});

export const getAppDetails = query(appQuery, async ({ appId, search, organizationId }) => {
  const { runtime, principal } = await remoteContext({ organizationId });
  const app = queryValue(await runtime.apps.get(principal, appId));
  const history = queryValue(await runtime.apps.history(principal, appId));
  const access = queryValue(await runtime.apps.access(principal, appId, search));

  const source = app.source;

  return { app, history, access, source };
});

export const getAppSource = query(appTarget, async ({ appId, organizationId }) => {
  const { runtime, principal } = await remoteContext({ organizationId });

  return queryValue(await runtime.source.read(principal, appId));
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
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    const app = formValue(await runtime.apps.create(principal, input));
    await getApps({ organizationId }).refresh();
    redirect(303, workspacePath(organization.slug, `/apps/${app.id}`));
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
  id: z.string().max(300).optional(),
  userId: z.string().min(1).max(128),
});

const refreshAccess = async (
  organization: { id: string; slug: string },
  appId: string,
  search: string,
) => {
  await getAppDetails({ appId, search, organizationId: organization.id }).refresh();

  if (!getRequestEvent().isRemoteRequest)
    redirect(
      303,
      workspacePath(
        organization.slug,
        `/apps/${appId}/access/management?${new URLSearchParams({ q: search, saved: "1" })}#access`,
      ),
    );

  return { saved: true };
};

export const grantAccess = form(accessInput, async ({ appId, userId, search, organizationId }) => {
  const { runtime, principal, organization } = await remoteContext({ organizationId });
  formValue(await runtime.apps.grant(principal, appId, userId));

  return refreshAccess(organization, appId, search);
});

export const revokeAccess = form(accessInput, async ({ appId, userId, search, organizationId }) => {
  const { runtime, principal, organization } = await remoteContext({ organizationId });
  formValue(await runtime.apps.revoke(principal, appId, userId));

  return refreshAccess(organization, appId, search);
});

export const rollbackApp = form(
  appQuery.extend({
    ...rollbackInput.shape,
    id: identifier.optional(),
    requestId: identifier,
  }),
  async ({ appId, artifactId, requestId, search, organizationId }) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    formValue(await runtime.apps.rollback(principal, appId, artifactId, requestId));
    await getAppDetails({ appId, search, organizationId }).refresh();

    if (!getRequestEvent().isRemoteRequest)
      redirect(303, workspacePath(organization.slug, `/apps/${appId}/deployments`));

    return { accepted: true };
  },
);

export const removeApp = form(
  appTarget.extend({
    confirmed: z
      .boolean()
      .optional()
      .refine((value) => value === true, "Please confirm permanent deletion."),
  }),
  async ({ appId, organizationId }) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    formValue(await runtime.apps.remove(principal, appId));
    await getApps({ organizationId }).refresh();
    redirect(303, workspacePath(organization.slug, "/apps"));
  },
);
