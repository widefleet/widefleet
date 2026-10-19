import { pageOrganizations } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });

  return { organizations: await pageOrganizations(request) };
};
