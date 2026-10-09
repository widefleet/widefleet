import { getCatalog } from "#lib/catalog.remote";
import { pagePrincipal } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await pagePrincipal(request);
  await getCatalog();
};
