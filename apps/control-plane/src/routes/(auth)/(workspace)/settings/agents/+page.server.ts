import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const { principal } = await parent();

  if (!principal.admin) error(403, "This page is only available to administrators.");
};
