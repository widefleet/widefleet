import type { AppSignIn } from "./app-sign-in.ts";
import type { Configuration } from "./config.ts";
import { appSsoConfiguration } from "../../../tools/edge-configuration.ts";
import {
  appCallbackUrl,
  buildAuthBundle,
  publishAuthBundle,
  readActivation,
  readActiveAuthBundle,
} from "./auth-bundle.ts";

export const createAppSignIn = (configuration: Configuration, cookieSecret: string): AppSignIn => ({
  callbackUrl: appCallbackUrl(configuration),
  publish: async (identity, clientSecret, force) => {
    const bundle = buildAuthBundle(configuration, identity, clientSecret, cookieSecret);
    await publishAuthBundle(configuration, bundle, force);

    return bundle.revision;
  },
  status: () => readActivation(configuration),
  plan: async (identity) => {
    const active = await readActiveAuthBundle(configuration);

    const nextProxy = identity
      ? appSsoConfiguration(identity.provider, identity.apps.clientId, "/runtime/client-secret")
      : null;

    const restartRequired =
      active !== null && JSON.stringify(active.proxy) !== JSON.stringify(nextProxy);

    return {
      restartRequired,
      message: restartRequired
        ? "This change restarts the sign-in service. Requests to published apps may fail temporarily, including for signed-in users."
        : "This change can be applied without restarting the sign-in service.",
    };
  },
});
