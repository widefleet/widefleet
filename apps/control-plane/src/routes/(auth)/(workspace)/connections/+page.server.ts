import { getUserConnections } from "#lib/user-connections.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await getUserConnections();
};
