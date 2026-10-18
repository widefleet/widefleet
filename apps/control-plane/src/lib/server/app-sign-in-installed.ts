import { authConfiguration } from "@platform/auth-proxy";
import { configurationRevision } from "@platform/auth-proxy/publication";
import { activationStatus } from "@platform/contracts";
import type { AppSignIn } from "./app-sign-in.ts";
import { appCallbackUrl } from "./app-sign-in.ts";
import type { Configuration } from "./config.ts";

export const createInstalledAppSignIn = (
  configuration: Configuration,
  cookieSecret: string | undefined,
  request: (method: "GET" | "PUT", body?: string) => Promise<{ text(): Promise<string> }>,
  propagation: "immediate" | "eventual",
): AppSignIn => {
  const prepare = (identity: Parameters<AppSignIn["publish"]>[0], clientSecret: string) =>
    authConfiguration.parse({
      provider: identity.provider,
      clientId: identity.apps.clientId,
      clientSecret,
      cookieSecret,
      domain: configuration.APP_DOMAIN,
      redirectUrl: appCallbackUrl(configuration),
    });

  return {
    callbackUrl: appCallbackUrl(configuration),
    revision: (identity, clientSecret) => configurationRevision(prepare(identity, clientSecret)),
    publish: async (identity, clientSecret) => {
      const input = prepare(identity, clientSecret);
      const expectedRevision = await configurationRevision(input);
      await request("PUT", JSON.stringify(input));

      return expectedRevision;
    },
    status: async (expectedRevision) => {
      try {
        const current = activationStatus.parse(JSON.parse(await (await request("GET")).text()));

        if (
          propagation === "immediate" &&
          expectedRevision &&
          current.revision !== expectedRevision
        )
          return {
            revision: expectedRevision,
            state: "failed",
            message: "The saved sign-in configuration is not installed. Save the settings again.",
          };

        return current;
      } catch {
        return {
          revision: expectedRevision,
          state: "failed",
          message: "The auth proxy is unavailable. Check the service and save the settings again.",
        };
      }
    },
    plan: () =>
      Promise.resolve({
        restartRequired: false,
        message:
          "The auth proxy applies this configuration without restarting. " +
          (propagation === "eventual" ? "KV propagation can take 60 seconds or longer. " : "") +
          "Changing the identity provider or app client requires signing in again.",
      }),
  };
};
