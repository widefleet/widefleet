import { error, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { remoteOperation } from "#server/remote-support";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
  setHeaders({ "referrer-policy": "no-referrer" });
  const request = url.searchParams.get("request");
  const ticket = url.searchParams.get("ticket");

  if (!request || !ticket) error(400, "This sign-in link is incomplete. Start the sign-in again.");
  const runtime = await getRuntime();
  const login = await remoteOperation(() => runtime.cliLogin.inspect(request, ticket));

  // The normal sign-in names the installation: Cloud accounts return here signed in, company
  // addresses return with the installation selected.
  if (!login.platformUrl && !locals.user)
    redirect(303, `/sign-in?${new URLSearchParams({ next: url.pathname + url.search })}`);

  return {
    request,
    ticket,
    email: url.searchParams.get("email") ?? locals.user?.email ?? "",
    ...login,
  };
};
