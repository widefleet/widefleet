import { error } from "@sveltejs/kit";
import { getAgents } from "#lib/agents.remote";
import { pagePrincipal } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const principal = await pagePrincipal();

  if (!principal.admin) error(403, "This page is only available to administrators.");
  await getAgents();
};
