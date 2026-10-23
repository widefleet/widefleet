import { command, query } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { getRuntime } from "#server/runtime";
import { remoteOperation } from "#server/remote-support";

const browserRequest = z.object({ request: z.string().max(128), ticket: z.string().max(128) });

export const inspectCliLogin = query(browserRequest, async ({ request, ticket }) => {
  const runtime = await getRuntime();

  return remoteOperation(() => runtime.cliLogin.inspect(request, ticket));
});

export const chooseCliPlatform = command(
  browserRequest.extend({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) }),
  async ({ request, ticket, email }) => {
    const runtime = await getRuntime();
    const login = await remoteOperation(() => runtime.cliLogin.inspect(request, ticket));
    let origin = login.platformUrl;

    if (!origin) {
      try {
        origin = await runtime.discoverPlatform(email.slice(email.lastIndexOf("@") + 1));
      } catch {
        error(503, "Could not find your company's platform. Retry or use its direct sign-in link.");
      }
    }

    return remoteOperation(() => runtime.cliLogin.select(request, ticket, origin));
  },
);
