import { getSettings } from "#lib/settings.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await getSettings();
};
