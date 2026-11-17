import { redirect } from "@sveltejs/kit";
import { pagePrincipal } from "#server/page-auth";
import { getRuntime } from "#server/runtime";
import { getApps } from "#lib/apps.remote";
import { z } from "zod";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders, url, cookies }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const principal = await pagePrincipal();

  if (
    !principal.application.admin &&
    cookies.get("widefleet_connections_seen") !==
      `${principal.id}:${principal.application.organizationId}` &&
    (await (await getRuntime()).userConnections.hasCandidates(principal))
  )
    redirect(303, "/connections?onboarding=1");
  await getApps();

  return {
    search: (url.searchParams.get("q") ?? "").trim().slice(0, 200),
    filter: z.enum(["all", "active", "preview"]).catch("all").parse(url.searchParams.get("filter")),
  };
};
