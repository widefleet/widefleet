import { getAppServices, getConnectionRequests } from "#lib/services.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await getAppServices();
  await getConnectionRequests();
};
