import { error } from "@sveltejs/kit";
import { appSlug } from "@platform/contracts";
import { getConnector } from "#lib/connectors.remote";
import { pagePrincipal } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, params, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });

  if (!(await pagePrincipal(request)).application.admin)
    error(403, "Organization administrator permission is required");
  const name = appSlug.safeParse(params.name);

  if (!name.success) error(400, "Invalid connector name");
  await getConnector(name.data);

  return { name: name.data, submitted: url.searchParams.has("submitted") };
};
