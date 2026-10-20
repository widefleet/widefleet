import { error } from "@sveltejs/kit";
import { appSlug } from "@platform/contracts";
import { pagePrincipal } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });

  if (!(await pagePrincipal(request)).application.admin)
    error(403, "Organization administrator permission is required");

  return {
    name: appSlug.safeParse(url.searchParams.get("name")).data ?? "",
    requestId: crypto.randomUUID(),
  };
};
