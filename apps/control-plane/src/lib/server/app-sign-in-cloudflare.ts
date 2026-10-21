import { createInstalledAppSignIn } from "./app-sign-in-installed.ts";
import type { Configuration } from "./config.ts";
import { authProxyRequest, type AuthProxyBindings } from "./cloudflare-auth-proxy.ts";
import { authConfigurationKey } from "@platform/auth-proxy/publication";
import { installationOrganizationId } from "../organization.ts";

export const createCloudflareAppSignIn = (
  configuration: Configuration,
  bindings: AuthProxyBindings & { APP_COOKIE_SECRET?: string },
  organizationId = installationOrganizationId,
) =>
  createInstalledAppSignIn(
    configuration,
    bindings.APP_COOKIE_SECRET,
    (method, body) =>
      authProxyRequest(bindings, `/${authConfigurationKey(organizationId)}`, method, body),
    "eventual",
    organizationId,
  );
