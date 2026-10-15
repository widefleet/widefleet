import { authConfiguration } from "@platform/auth-proxy";
import { configurationRevision } from "@platform/auth-proxy/publication";
import { activationStatus } from "@platform/contracts";
import type { AppSignIn } from "./app-sign-in.ts";
import { appCallbackUrl } from "./app-sign-in.ts";
import type { Configuration } from "./config.ts";
import { authProxyRequest, type AuthProxyBindings } from "./cloudflare-auth-proxy.ts";

export const createCloudflareAppSignIn = (
  configuration: Configuration,
  bindings: AuthProxyBindings & { APP_COOKIE_SECRET?: string },
): AppSignIn => {
  const request = (method: string, body?: string) =>
    authProxyRequest(bindings, "/configuration", method, body);

  return {
    callbackUrl: appCallbackUrl(configuration),
    publish: async (identity, clientSecret, force) => {
      const input = authConfiguration.parse({
        provider: identity.provider,
        clientId: identity.apps.clientId,
        clientSecret,
        cookieSecret: bindings.APP_COOKIE_SECRET,
        domain: configuration.APP_DOMAIN,
        redirectUrl: appCallbackUrl(configuration),
      });

      // Settings reads must not republish stale snapshots or exhaust KV's write limit.
      // Saving, explicitly applying, and initialization already request publication.
      if (force) await request("PUT", JSON.stringify(input));

      return configurationRevision(input);
    },
    status: async () => activationStatus.parse(JSON.parse(await (await request("GET")).text())),
    plan: () =>
      Promise.resolve({
        restartRequired: false,
        message:
          "The auth proxy applies this configuration without restarting. KV propagation can take 60 seconds or longer. Changing the identity provider or app client requires signing in again.",
      }),
  };
};
