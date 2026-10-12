import { error } from "@sveltejs/kit";
import { identifier } from "@platform/contracts";
import { getConnectorCatalog, getAppConnections } from "#lib/connectors.remote";
import { getAppDetails } from "#lib/apps.remote";
import { pagePrincipal } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await pagePrincipal(request);
  await getConnectorCatalog();
  const selected = url.searchParams.get("app");

  if (!selected) return { app: null };
  const appId = identifier.safeParse(selected);

  if (!appId.success) error(400, "Invalid app identifier.");
  const details = await getAppDetails({ appId: appId.data });
  await getAppConnections({ appId: appId.data });

  return { app: details.app };
};
