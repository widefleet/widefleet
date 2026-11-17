import { createInstalledAppSignIn } from "./app-sign-in-installed.ts";
import type { Configuration } from "./config.ts";
import { authProxyRequest, type AuthProxyBindings } from "./cloudflare-auth-proxy.ts";
import { installationOrganizationId } from "../organization.ts";

export const createCloudflareAppSignIn = (
  configuration: Configuration,
  bindings: AuthProxyBindings & { APP_COOKIE_SECRET?: string },
  organizationId = installationOrganizationId,
) =>
  createInstalledAppSignIn(
    configuration,
    bindings.APP_COOKIE_SECRET,
    (path, method, body) => authProxyRequest(bindings, path, method, body),
    "eventual",
    organizationId,
  );
