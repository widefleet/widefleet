import { form, getRequestEvent, query } from "$app/server";
import { redirect } from "@sveltejs/kit";
import { z } from "zod";
import * as contract from "@platform/contracts";
import { formValue, queryValue, remoteContext } from "#server/remote-support";
import { pageFailure } from "#server/page-auth";

export const getConnectorLogs = query(contract.connectorLogQuery, async (input) => {
  const { runtime, principal } = await remoteContext();
  const result = await runtime.telemetry.queryConnector(principal, input);

  if (result.isErr()) {
    if (result.error._tag === "InvalidOperation") pageFailure(result.error);

    return { page: null, message: result.error.message };
  }

  return { page: result.value, message: null };
});

export const getConnectorCatalog = query(async () => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.connectors.catalog(principal));
});

export const getAppConnections = query(contract.appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.connectors.connections(principal, appId));
});

export const getConnector = query(contract.appSlug, async (name) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.connectors.read(principal, name));
});

export const setConnectorSecret = form(
  contract.connectorSecretPath.extend({
    ...contract.organizationSelection.shape,
    // SvelteKit omits underscore-prefixed fields from failed form responses.
    _value: contract.connectorSecretValue,
  }),
  async ({ name, secret, _value, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.connectors.setSecret(principal, name, secret, _value));
    await getConnector(name).refresh();
    // Always navigate away from the submitted secret, including without JavaScript.
    redirect(303, `/connectors/${name}?submitted=1`);
  },
);

export const deleteConnectorSecret = form(
  contract.connectorSecretPath.extend({
    ...contract.organizationSelection.shape,
    id: z.string().max(160).optional(),
  }),
  async ({ name, secret, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.connectors.setSecret(principal, name, secret, null));
    await getConnector(name).refresh();

    if (!getRequestEvent().isRemoteRequest) redirect(303, `/connectors/${name}?submitted=1`);

    return { submitted: true };
  },
);

export const changeConnectorBinding = form(
  contract.capabilityPath.extend({
    ...contract.organizationSelection.shape,
    connector: contract.appSlug,
    entrypoint: contract.capabilityGrant.shape.entrypoint,
  }),
  async ({ appId, binding, connector, entrypoint, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.connectors.bind(principal, appId, binding, { connector, entrypoint }));
    await getAppConnections({ appId }).refresh();

    if (!getRequestEvent().isRemoteRequest) redirect(303, `/connectors?app=${appId}&submitted=1`);

    return { submitted: true };
  },
);

export const removeConnectorBinding = form(
  contract.capabilityPath.extend({
    ...contract.organizationSelection.shape,
    id: z.string().max(160).optional(),
  }),
  async ({ appId, binding, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.connectors.bind(principal, appId, binding, null));
    await getAppConnections({ appId }).refresh();

    if (!getRequestEvent().isRemoteRequest) redirect(303, `/connectors?app=${appId}&submitted=1`);

    return { submitted: true };
  },
);
