import type { AppSignIn } from "./app-sign-in.ts";
import type { Configuration } from "./config.ts";
import {
  appCallbackUrl,
  buildAuthBundle,
  publishAuthBundle,
  readActivation,
} from "./auth-bundle.ts";

export const createAppSignIn = (configuration: Configuration, cookieSecret: string): AppSignIn => ({
  callbackUrl: appCallbackUrl(configuration),
  publish: async (identity, clientSecret, force) => {
    const bundle = buildAuthBundle(configuration, identity, clientSecret, cookieSecret);
    await publishAuthBundle(configuration, bundle, force);

    return bundle.revision;
  },
  status: () => readActivation(configuration),
  plan: () =>
    Promise.resolve({
      restartRequired: false,
      message:
        "The auth proxy applies this configuration without restarting. Changing the identity provider or app client requires signing in again.",
    }),
});
