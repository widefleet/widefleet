import { createInstalledAppSignIn } from "./app-sign-in-installed.ts";
import type { Configuration } from "./config.ts";
import { authProxyRequest, type AuthProxyBindings } from "./cloudflare-auth-proxy.ts";

export const createCloudflareAppSignIn = (
  configuration: Configuration,
  bindings: AuthProxyBindings & { APP_COOKIE_SECRET?: string },
) =>
  createInstalledAppSignIn(
    configuration,
    bindings.APP_COOKIE_SECRET,
    (method, body) => authProxyRequest(bindings, "/configuration", method, body),
    "eventual",
  );
