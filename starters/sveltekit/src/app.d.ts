import type { AppUser } from "./lib/server/identity.ts";

declare global {
  namespace App {
    interface Locals {
      user: AppUser;
      requestId: string;
      errorReported?: boolean;
    }

    interface Platform {
      env: Cloudflare.Env & { WIDEFLEET_DEPLOYMENT_ID?: string };
    }
  }
}
