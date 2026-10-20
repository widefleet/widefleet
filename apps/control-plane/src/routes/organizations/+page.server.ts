import { pageOrganizations } from "#server/page-auth";
import { localDestination } from "#server/navigation";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });

  return {
    organizations: await pageOrganizations(request),
    next: localDestination(url.searchParams.get("next")),
  };
};
