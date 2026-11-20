import { hasAppAccess } from "@platform/contracts";
import { readApp } from "./catalog.ts";
import { serviceRoute } from "./mcp-authorization.ts";
import type { ParentEnvironment } from "./types.ts";

// The organization's published app that exports the entrypoint, if any.
export const appTarget = async (
  environment: ParentEnvironment,
  organizationId: string,
  hostname: string,
  entrypoint: string,
) => {
  const route = await serviceRoute(environment, hostname);

  if (!route || route.organizationId !== organizationId) return null;

  const app = await readApp(environment, `hosts/${hostname}.json`, {
    appId: route.appId,
    organizationId: route.organizationId,
  });

  if (
    !app ||
    app.appId !== route.appId ||
    app.organizationId !== route.organizationId ||
    !app.metadata.entrypoints?.includes(entrypoint)
  )
    return null;

  return { app, route };
};

// As appTarget, for a caller the app's access groups admit.
export const serviceTarget = async (
  environment: ParentEnvironment,
  organizationId: string,
  identity: { groups: string[] },
  hostname: string,
  entrypoint: string,
) => {
  const target = await appTarget(environment, organizationId, hostname, entrypoint);

  return target && hasAppAccess(target.route.access.groups, identity.groups) ? target.app : null;
};
