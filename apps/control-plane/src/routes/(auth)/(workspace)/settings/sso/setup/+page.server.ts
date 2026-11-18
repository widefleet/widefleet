import { redirect } from "@sveltejs/kit";
import { getSettings } from "#lib/settings.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders, url }) => {
  setHeaders({ "cache-control": "private, no-store" });

  // An active connection is managed on its own page.
  if ((await getSettings()).view.ssoRequired) redirect(303, "/settings/sso");

  return { loginFailed: url.searchParams.has("error") };
};
