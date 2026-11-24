import { form, getRequestEvent, query } from "$app/server";
import { error, redirect } from "@sveltejs/kit";
import {
  appPath,
  createAgentInput,
  createAppInput,
  identifier,
  organizationSelection,
  rollbackInput,
} from "@platform/contracts";
import { z } from "zod";
import { InvalidOperation } from "#server/errors";
import { createAppPrompt } from "#server/app-templates";
import { formValue, queryValue, remoteContext } from "#server/remote-support";
import { workspacePath } from "#lib/workspace-path";

const appTarget = appPath.extend(organizationSelection.shape);

const appQuery = appTarget.extend({ search: z.string().trim().max(200).default("") });

export const getApps = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return {
    principal,
    apps: queryValue(await runtime.apps.list(principal)),
    createPrompt: createAppPrompt(principal, runtime.configuration),
  };
});

// The new app form needs creator permission. A preview link also needs its original app.
export const getAppCreation = query(
  organizationSelection.extend({ parentId: z.string().max(100).nullable() }),
  async ({ organizationId, parentId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    if (!principal.creator) error(403, "You do not have permission to create apps.");
    const apps = queryValue(await runtime.apps.list(principal));
    const originals = apps.filter((app) => app.state !== "deleting" && !app.parentId);
    const parent = originals.find((app) => app.id === parentId);

    if (parentId !== null && !parent)
      error(404, "The original app is no longer available. This preview cannot be created.");

    return { originals, parentId: parent?.id ?? "" };
  },
);

export const getAppDetails = query(appQuery, async ({ appId, search, organizationId }) => {
  const { runtime, principal, organization } = await remoteContext({ organizationId });
  const found = await runtime.apps.get(principal, appId);

  // People who do not manage the app are led to the page the catalog has for it.
  if (found.isErr() && found.error instanceof InvalidOperation && found.error.code === "NOT_FOUND")
    redirect(303, workspacePath(organization.slug, `/catalog/apps/${appId}`));
  const app = queryValue(found);
  const history = queryValue(await runtime.apps.history(principal, appId));
  const access = queryValue(await runtime.apps.access(principal, appId, search));

  const source = app.source;

  // The rollback form sends this key so a repeated submission starts only one deployment. It
  // comes with the data so the server-rendered form and the hydrated page share it.
  return { app, history, access, source, requestId: crypto.randomUUID() };
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
