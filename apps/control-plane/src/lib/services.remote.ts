import { form, query } from "$app/server";
import { redirect } from "@sveltejs/kit";
import * as contract from "@platform/contracts";
import { z } from "zod";
import { remoteContext, queryValue, formValue } from "#server/remote-support";
import { getAppConnections } from "./connections.remote.ts";
import { renderServiceDocumentation } from "#server/service-documentation";

export const getAppServices = query(async () => {
  const { runtime, principal } = await remoteContext();

  return {
    admin: principal.application.admin,
    entries: queryValue(await runtime.connections.services(principal)),
  };
});

export const getServiceUserAccess = query(contract.appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.connections.userAccess(principal, appId));
});

export const changeServiceUserAccess = form(
  contract.appPath.extend({
    ...contract.organizationSelection.shape,
    revision: z.number().int().nonnegative(),
    entrypoint: contract.serviceGrant.shape.entrypoint,
    kind: z.enum(["user", "group"]),
    action: z.enum(["add", "remove"]),
    issuer: z.string().default(""),
    subject: z.string().default(""),
    group: z.string().default(""),
    id: z.string().optional(),
  }),
  async ({ organizationId, appId, revision, entrypoint, kind, action, issuer, subject, group }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    const state = queryValue(await runtime.connections.userAccess(principal, appId));
    const grants = state.grants.filter((entry) => entry.entrypoint !== entrypoint);

    const current = state.grants.find((entry) => entry.entrypoint === entrypoint) ?? {
      entrypoint,
      users: [],
      groups: [],
    };

    if (kind === "user") {
      const user = contract.serviceUser.parse({ issuer, subject });
      current.users = current.users.filter(
        (entry) => entry.issuer !== user.issuer || entry.subject !== user.subject,
      );

      if (action === "add") current.users.push(user);
    } else {
      const value = contract.appAccessGroup.parse(group);
      current.groups = current.groups.filter((entry) => entry !== value);

      if (action === "add") current.groups.push(value);
    }

    if (current.users.length || current.groups.length) grants.push(current);
    formValue(await runtime.connections.setUserAccess(principal, appId, { revision, grants }));
    await getServiceUserAccess({ appId }).refresh();
    redirect(303, `/services/${appId}/availability?saved=1`);
  },
);

export const getServiceDescription = query(contract.servicePath, async ({ service }) => {
  const { runtime, principal } = await remoteContext();
  const description = queryValue(await runtime.connections.describe(principal, service));

  return {
    ...description,
    html: description.documentation ? renderServiceDocumentation(description.documentation) : null,
  };
});

export const getConnectionRequests = query(async () => {
  const { runtime, principal } = await remoteContext();

  return {
    admin: principal.application.admin,
    entries: queryValue(await runtime.connections.requests(principal)),
  };
});

export const setServiceAccess = form(
  contract.appPath.extend({
    ...contract.organizationSelection.shape,
    ...contract.serviceAccessChange.shape,
    id: z.string().max(160).optional(),
  }),
  async ({ organizationId, appId, accessMode }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.connections.setAccess(principal, appId, accessMode));
    await getServiceUserAccess({ appId }).refresh();
    await getAppServices().refresh();
    redirect(303, `/services/${appId}/availability?saved=1`);
  },
);

export const requestAppConnection = form(
  contract.capabilityPath.extend({
    ...contract.organizationSelection.shape,
    id: z.string().max(160).optional(),
    targetApp: contract.identifier,
    entrypoint: contract.capabilityGrant.shape.entrypoint,
  }),
  async ({ organizationId, targetApp, appId, binding, entrypoint }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    const request = formValue(
      await runtime.connections.request(principal, { appId, binding, entrypoint, app: targetApp }),
    );

    await getConnectionRequests().refresh();
    redirect(303, `/services/requests/${request.id}`);
  },
);

export const decideConnectionRequest = form(
  contract.connectionRequestPath.extend({
    ...contract.organizationSelection.shape,
    decision: z.enum(["approve", "reject"]),
    id: z.string().max(160).optional(),
  }),
  async ({ organizationId, requestId, decision }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.connections[decision](principal, requestId));
    await getConnectionRequests().refresh();
    redirect(303, "/services/requests");
  },
);

export const connectApp = form(
  contract.capabilityPath.extend({
    ...contract.organizationSelection.shape,
    id: z.string().max(160).optional(),
    guided: z.literal("true").optional(),
    targetApp: contract.identifier,
    entrypoint: contract.capabilityGrant.shape.entrypoint,
  }),
  async ({ appId, targetApp, binding, entrypoint, organizationId, guided }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(
      await runtime.connections.bind(principal, appId, binding, { app: targetApp, entrypoint }),
    );
    await getAppConnections({ appId }).refresh();

    if (guided)
      redirect(
        303,
        `/services/${targetApp}/connect/result?${new URLSearchParams({ app: appId, binding })}`,
      );
    redirect(303, `/apps/${appId}/connections`);
  },
);

export const disconnectApp = form(
  contract.capabilityPath.extend({
    ...contract.organizationSelection.shape,
    id: z.string().max(160).optional(),
  }),
  async ({ appId, binding, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.connections.bind(principal, appId, binding, null));
    await getAppConnections({ appId }).refresh();
    redirect(303, `/apps/${appId}/connections`);
  },
);

export const getAppSecrets = query(contract.appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.appSecrets.read(principal, appId));
});

const secretPath = contract.appPath.extend({
  ...contract.organizationSelection.shape,
  secret: contract.appSecretName,
});

export const putAppSecret = form(
  secretPath.extend({ _value: contract.appSecretValue }),
  async ({ appId, secret, _value, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.appSecrets.set(principal, appId, secret, _value));
    await getAppSecrets({ appId }).refresh();
    redirect(303, `/apps/${appId}/secrets?submitted=1`);
  },
);

export const deleteAppSecret = form(
  secretPath.extend({ id: z.string().max(160).optional() }),
  async ({ appId, secret, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.appSecrets.set(principal, appId, secret, null));
    await getAppSecrets({ appId }).refresh();
    redirect(303, `/apps/${appId}/secrets?submitted=1`);
  },
);
