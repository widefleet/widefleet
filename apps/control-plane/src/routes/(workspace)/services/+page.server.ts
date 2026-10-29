import { error } from "@sveltejs/kit";
import { identifier } from "@platform/contracts";
import { getAppServices } from "#lib/services.remote";
import { getAppDetails } from "#lib/apps.remote";
import { getAppConnections } from "#lib/connections.remote";
import { pagePrincipal } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await pagePrincipal(request);
  await getAppServices();
  const selected = url.searchParams.get("app");

  if (!selected) return { app: null };
  const id = identifier.safeParse(selected);

  if (!id.success) error(400, "Invalid app identifier");
  const { app } = await getAppDetails({ appId: id.data });
  await getAppConnections({ appId: id.data });

  return { app };
};
