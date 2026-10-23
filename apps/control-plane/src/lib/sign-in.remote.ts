import { command } from "$app/server";
import { z } from "zod";
import { getRuntime } from "#server/runtime";
import { remoteOperation } from "#server/remote-support";
import { error } from "@sveltejs/kit";
import { localDestination } from "#server/navigation";
import { cloudPlatformUrl, companySignInUrl } from "#server/platform-discovery";

export const findSignInDestination = command(
  z.object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    next: z.string().max(4096),
  }),
  async ({ email, next }) => {
    const runtime = await getRuntime();

    // Device grants already belong to one installation. Never rediscover their issuer.
    const path = new URL(localDestination(next), runtime.configuration.PLATFORM_URL).pathname;
    const deviceLogin = path === "/device";

    if (runtime.configuration.PLATFORM_URL === cloudPlatformUrl && !deviceLogin) {
      const domain = email.slice(email.lastIndexOf("@") + 1);
      let origin: string;

      try {
        origin = await runtime.discoverPlatform(domain);
      } catch {
        error(
          503,
          "Could not determine your company's platform. Retry or use its direct sign-in link.",
        );
      }

      if (origin !== cloudPlatformUrl) {
        return {
          url: await remoteOperation(async () => companySignInUrl(origin, email, next)),
          provider: null,
        };
      }
    }

    return { url: null, provider: await remoteOperation(() => runtime.signInProvider(email)) };
  },
);
