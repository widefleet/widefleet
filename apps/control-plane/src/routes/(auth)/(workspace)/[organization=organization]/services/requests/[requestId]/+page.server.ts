import { error } from "@sveltejs/kit";
import { getConnectionRequests } from "#lib/services.remote";
import { pageMember } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const { organization } = await pageMember();
  const requests = await getConnectionRequests({ organizationId: organization.id });
  const request = requests.entries.find((entry) => entry.id === params.requestId);

  if (!request) error(404, "Connection request not found");

  return { request };
};
