import { command, getRequestEvent, query } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { getRuntime } from "#server/runtime";
import { remoteOperation } from "#server/remote-support";
import { selectCliPlatformByEmail } from "#server/cli-login";

const browserRequest = z.object({ request: z.string().max(128), ticket: z.string().max(128) });

export const inspectCliLogin = query(browserRequest, async ({ request, ticket }) => {
  const runtime = await getRuntime();

  return remoteOperation(() => runtime.cliLogin.inspect(request, ticket));
});

// A signed-in visitor continues with the address of their session.
export const chooseCliPlatform = command(browserRequest, async ({ request, ticket }) => {
  const { user } = getRequestEvent().locals;

  if (!user) error(401, "Sign in to continue");
  const runtime = await getRuntime();

  return remoteOperation(() =>
    selectCliPlatformByEmail(runtime.cliLogin, runtime.discoverPlatform, {
      id: request,
      ticket,
      email: user.email,
    }),
  );
});
