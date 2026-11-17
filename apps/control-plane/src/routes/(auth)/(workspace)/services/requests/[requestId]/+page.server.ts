import { error } from "@sveltejs/kit";
import { getConnectionRequests } from "#lib/services.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const requests = await getConnectionRequests();
  const request = requests.entries.find((entry) => entry.id === params.requestId);

  if (!request) error(404, "Connection request not found");

  return { request };
};
