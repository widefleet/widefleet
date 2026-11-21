import { getSettings } from "#lib/settings.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders, url }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await getSettings();

  return {
    loginFailed: url.searchParams.has("error"),
  };
};
