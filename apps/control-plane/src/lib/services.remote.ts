import { form, query } from "$app/server";
import { redirect } from "@sveltejs/kit";
import * as contract from "@platform/contracts";
import { z } from "zod";
import { remoteContext, queryValue, formValue } from "#server/remote-support";
import { getAppConnections } from "./connections.remote.ts";

export const getAppServices = query(async () => {
  const { runtime, principal } = await remoteContext();

  return {
    admin: principal.application.admin,
    entries: queryValue(await runtime.connections.services(principal)),
  };
});

export const connectApp = form(
  contract.capabilityPath.extend({
    ...contract.organizationSelection.shape,
    targetApp: contract.identifier,
    entrypoint: contract.capabilityGrant.shape.entrypoint,
  }),
  async ({ appId, targetApp, binding, entrypoint, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(
      await runtime.connections.bind(principal, appId, binding, { app: targetApp, entrypoint }),
    );
    await getAppConnections({ appId }).refresh();
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
