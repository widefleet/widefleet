import { form, query } from "$app/server";
import { error, redirect } from "@sveltejs/kit";
import * as contract from "@platform/contracts";
import { z } from "zod";
import { remoteContext, queryValue, formValue } from "#server/remote-support";
import { getAppConnections } from "./connections.remote.ts";
import { presentServiceDocumentation } from "#server/service-documentation";
import { workspacePath } from "#lib/workspace-path";

export const getAppServices = query(contract.organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return {
    admin: principal.application.admin,
    entries: queryValue(await runtime.connections.services(principal)),
  };
});

export const getServiceDescription = query(
  contract.servicePath.extend(contract.organizationSelection.shape),
  async ({ service, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    const description = queryValue(await runtime.connections.reference(principal, service));

    return {
      ...description,
      reference: description.documentation
        ? presentServiceDocumentation(description.documentation)
        : null,
    };
  },
);

// API pages name the API by its app identifier or its slug.
const findService = <T extends { appId: string; slug: string }>(entries: T[], service: string) =>
  entries.find((entry) => entry.appId === service) ??
  entries.find((entry) => entry.slug === service);

const optionalText = z.string().max(200).nullable();

// The API list can be opened for one app, which the page then names.
export const getServiceListApp = query(
  contract.organizationSelection.extend({ app: optionalText }),
  async ({ organizationId, app }) => {
    if (app === null) return null;
    const appId = contract.identifier.safeParse(app);

    if (!appId.success) error(400, "Invalid app identifier");
    const { runtime, principal } = await remoteContext({ organizationId });

    return queryValue(await runtime.apps.get(principal, appId.data));
  },
);

export const getServiceAvailability = query(
  contract.servicePath.extend(contract.organizationSelection.shape),
  async ({ organizationId, service }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    if (!principal.application.admin)
      error(403, "Organization administrator permission is required");
    const entry = findService(queryValue(await runtime.connections.services(principal)), service);

    if (!entry) error(404, "API not found");

    return entry;
  },
);

export const getServiceConnection = query(
  contract.servicePath.extend({ ...contract.organizationSelection.shape, app: optionalText }),
  async ({ organizationId, service, app }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    const entry = findService(queryValue(await runtime.connections.services(principal)), service);

    if (!entry) error(404, "API not found");

    const applications = queryValue(await runtime.apps.list(principal)).filter(
      (candidate) => candidate.id !== entry.appId,
    );

    if (app !== null && !contract.identifier.safeParse(app).success)
      error(400, "Invalid app identifier");
    const selected = app === null ? null : applications.find((candidate) => candidate.id === app);

    if (selected === undefined) error(404, "App not found");

    return {
      service: entry,
      applications,
      app: selected,
      approval: !principal.application.admin && entry.accessMode === "approval_required",
    };
  },
);

export const getConnectionResult = query(
  contract.servicePath.extend({
    ...contract.organizationSelection.shape,
    app: optionalText,
    binding: optionalText,
  }),
  async ({ organizationId, service, app, binding }) => {
    const appId = contract.identifier.safeParse(app);
    const name = contract.bindingName.safeParse(binding);

    if (!appId.success || !name.success) error(400, "Invalid connection");
    const { runtime, principal } = await remoteContext({ organizationId });
    const connections = queryValue(await runtime.connections.connections(principal, appId.data));
    const grant = connections.connections.grants[name.data];

    if (!grant || grant.app !== service) error(404, "Connection not found");

    const entry = queryValue(await runtime.apps.list(principal)).find(
      (candidate) => candidate.id === appId.data,
    );

    if (!entry) error(404, "App not found");
    const services = queryValue(await runtime.connections.services(principal));

    return {
      app: entry,
      binding: name.data,
      serviceName:
        services.find((candidate) => candidate.appId === grant.app)?.displayName ?? "API",
      connections,
    };
  },
);

export const getConnectionRequests = query(contract.organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return {
    admin: principal.application.admin,
    entries: queryValue(await runtime.connections.requests(principal)),
  };
});

export const getConnectionRequest = query(
  contract.organizationSelection.extend({ requestId: z.string().max(128) }),
  async ({ organizationId, requestId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    const requests = queryValue(await runtime.connections.requests(principal));
    const request = requests.find((entry) => entry.id === requestId);

    if (!request) error(404, "Connection request not found");

    return request;
  },
);

export const setServiceAccess = form(
  contract.appPath.extend({
    ...contract.organizationSelection.shape,
    ...contract.serviceAccessChange.shape,
    id: z.string().max(160).optional(),
  }),
  async ({ organizationId, appId, accessMode }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.connections.setAccess(principal, appId, accessMode));

    // The page names the API by identifier or slug, so every query on it refreshes.
    return { saved: true };
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
    const { runtime, principal, organization } = await remoteContext({ organizationId });

    const request = formValue(
      await runtime.connections.request(principal, { appId, binding, entrypoint, app: targetApp }),
    );

    await getConnectionRequests({ organizationId }).refresh();
    redirect(303, workspacePath(organization.slug, `/services/requests/${request.id}`));
  },
);

export const decideConnectionRequest = form(
  contract.connectionRequestPath.extend({
    ...contract.organizationSelection.shape,
    decision: z.enum(["approve", "reject"]),
    id: z.string().max(160).optional(),
  }),
  async ({ organizationId, requestId, decision }) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    formValue(await runtime.connections[decision](principal, requestId));
    await getConnectionRequests({ organizationId }).refresh();
    redirect(303, workspacePath(organization.slug, "/services/requests"));
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
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    formValue(
      await runtime.connections.bind(principal, appId, binding, { app: targetApp, entrypoint }),
    );
    await getAppConnections({ appId, organizationId }).refresh();

    if (guided)
      redirect(
        303,
        workspacePath(
          organization.slug,
          `/services/${targetApp}/connect/result?${new URLSearchParams({ app: appId, binding })}`,
        ),
      );
    redirect(303, workspacePath(organization.slug, `/apps/${appId}/connections`));
  },
);

export const disconnectApp = form(
  contract.capabilityPath.extend({
    ...contract.organizationSelection.shape,
    id: z.string().max(160).optional(),
  }),
  async ({ appId, binding, organizationId }) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    formValue(await runtime.connections.bind(principal, appId, binding, null));
    await getAppConnections({ appId, organizationId }).refresh();
    redirect(303, workspacePath(organization.slug, `/apps/${appId}/connections`));
  },
);

export const getAppSecrets = query(
  contract.appPath.extend(contract.organizationSelection.shape),
  async ({ appId, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    return queryValue(await runtime.appSecrets.read(principal, appId));
  },
);

const secretPath = contract.appPath.extend({
  ...contract.organizationSelection.shape,
  secret: contract.appSecretName,
});

export const putAppSecret = form(
  secretPath.extend({ _value: contract.appSecretValue }),
  async ({ appId, secret, _value, organizationId }) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    formValue(await runtime.appSecrets.set(principal, appId, secret, _value));
    await getAppSecrets({ appId, organizationId }).refresh();
    redirect(303, workspacePath(organization.slug, `/apps/${appId}/secrets?submitted=1`));
  },
);

export const deleteAppSecret = form(
  secretPath.extend({ id: z.string().max(160).optional() }),
  async ({ appId, secret, organizationId }) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    formValue(await runtime.appSecrets.set(principal, appId, secret, null));
    await getAppSecrets({ appId, organizationId }).refresh();
    redirect(303, workspacePath(organization.slug, `/apps/${appId}/secrets?submitted=1`));
  },
);
