import { getApps } from "#lib/apps.remote";
import { pagePrincipal } from "#server/page-auth";
import { z } from "zod";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, setHeaders, url }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await pagePrincipal(request);
  await getApps();

  return {
    search: (url.searchParams.get("q") ?? "").trim().slice(0, 200),
    filter: z.enum(["all", "active", "preview"]).catch("all").parse(url.searchParams.get("filter")),
  };
};
