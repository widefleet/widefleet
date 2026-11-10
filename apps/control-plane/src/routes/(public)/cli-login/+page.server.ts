import { error } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { remoteOperation } from "#server/remote-support";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
  const request = url.searchParams.get("request");
  const ticket = url.searchParams.get("ticket");

  if (!request || !ticket) error(400, "Open the link from widefleet login.");
  const runtime = await getRuntime();
  const login = await remoteOperation(() => runtime.cliLogin.inspect(request, ticket));

  return { request, ticket, ...login };
};
