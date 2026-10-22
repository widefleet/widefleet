import { command } from "$app/server";
import { z } from "zod";
import { getRuntime } from "#server/runtime";
import { remoteOperation } from "#server/remote-support";

export const findSignInProvider = command(
  z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) }),
  async ({ email }) => {
    const runtime = await getRuntime();

    return remoteOperation(() => runtime.signInProvider(email));
  },
);
