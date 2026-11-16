import { error } from "@sveltejs/kit";
import { identifier, bindingName } from "@platform/contracts";
import { getAppConnections } from "#lib/connections.remote";
import { getApps } from "#lib/apps.remote";
import { getAppServices } from "#lib/services.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const appId = identifier.safeParse(url.searchParams.get("app"));
  const binding = bindingName.safeParse(url.searchParams.get("binding"));

  if (!appId.success || !binding.success) error(400, "Invalid connection");
  const connections = await getAppConnections({ appId: appId.data });
  const grant = connections.connections.grants[binding.data];

  if (!grant || grant.app !== params.service) error(404, "Connection not found");
  const applications = await getApps();
  const app = applications.apps.find((entry) => entry.id === appId.data);

  if (!app) error(404, "App not found");
  const catalog = await getAppServices();

  const serviceName =
    catalog.entries.find((entry) => entry.appId === grant.app)?.displayName ?? "API";

  return { app, binding: binding.data, serviceName, connections };
};
