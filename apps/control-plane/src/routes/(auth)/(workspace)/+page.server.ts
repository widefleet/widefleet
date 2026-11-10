import { getApps } from "#lib/apps.remote";
import { z } from "zod";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders, url }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await getApps();

  return {
    search: (url.searchParams.get("q") ?? "").trim().slice(0, 200),
    filter: z.enum(["all", "active", "preview"]).catch("all").parse(url.searchParams.get("filter")),
  };
};
