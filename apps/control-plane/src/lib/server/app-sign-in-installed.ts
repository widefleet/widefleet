import { authConfiguration } from "@platform/auth-proxy";
import { authConfigurationKey, configurationRevision } from "@platform/auth-proxy/publication";
import { mcpLoginConfiguration } from "@platform/auth-proxy/mcp-login";
import { activationStatus } from "@platform/contracts";
import type { AppSignIn } from "./app-sign-in.ts";
import { appCallbackUrl } from "./app-sign-in.ts";
import type { Configuration } from "./config.ts";
import { installationOrganizationId } from "../organization.ts";

export const createInstalledAppSignIn = (
  configuration: Configuration,
  cookieSecret: string | undefined,
  request: (
    path: string,
    method: "GET" | "PUT" | "DELETE",
    body?: string,
  ) => Promise<{ text(): Promise<string> }>,
  propagation: "immediate" | "eventual",
  organizationId = installationOrganizationId,
): AppSignIn => {
  const prepare = (
    identity: Parameters<AppSignIn["publish"]>[0],
    clientSecret: string,
    organizationName?: string,
    emailDomains: string[] = [],
  ) =>
    authConfiguration.parse({
      organizationId,
      organizationName,
      provider: identity.provider,
      scopes: identity.scopes,
      clientId: identity.management.clientId,
      clientSecret,
      cookieSecret,
      domain: configuration.APP_DOMAIN,
      redirectUrl: appCallbackUrl(configuration, organizationId),
      emailDomains: emailDomains.length ? emailDomains : undefined,
    });

  return {
    callbackUrl: appCallbackUrl(configuration, organizationId),
    revoke: async () => {
      await request(`/${authConfigurationKey(organizationId)}`, "DELETE");
    },
    revision: (identity, clientSecret, organizationName, emailDomains) =>
      configurationRevision(prepare(identity, clientSecret, organizationName, emailDomains)),
    publish: async (identity, clientSecret, organizationName, emailDomains) => {
      const input = prepare(identity, clientSecret, organizationName, emailDomains);
      const expectedRevision = await configurationRevision(input);
      const origin = new URL(input.redirectUrl);
      origin.hostname = `mcp.${configuration.APP_DOMAIN}`;

      const login = mcpLoginConfiguration.parse({
        origin: origin.origin,
        platformUrl: configuration.PLATFORM_URL,
        google:
          configuration.GOOGLE_CLIENT_ID && configuration.GOOGLE_CLIENT_SECRET
            ? {
                clientId: configuration.GOOGLE_CLIENT_ID,
                clientSecret: configuration.GOOGLE_CLIENT_SECRET,
              }
            : undefined,
        microsoft:
          configuration.MICROSOFT_CLIENT_ID && configuration.MICROSOFT_CLIENT_SECRET
            ? {
                clientId: configuration.MICROSOFT_CLIENT_ID,
                clientSecret: configuration.MICROSOFT_CLIENT_SECRET,
              }
            : undefined,
      });

      await request("/mcp/login", "PUT", JSON.stringify(login));
      await request(`/${authConfigurationKey(organizationId)}`, "PUT", JSON.stringify(input));

      return expectedRevision;
    },
    status: async (expectedRevision) => {
      try {
        const current = activationStatus.parse(
          JSON.parse(
            await (await request(`/${authConfigurationKey(organizationId)}`, "GET")).text(),
          ),
        );

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
