import { redirect } from "@sveltejs/kit";
import { getSettings } from "#lib/settings.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders, url }) => {
  setHeaders({ "cache-control": "private, no-store" });

  if (!(await getSettings()).view.sso) redirect(303, "/settings/sso/setup");

  return { loginFailed: url.searchParams.has("error") };
};
