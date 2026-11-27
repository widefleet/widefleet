import { OAuthAuthorizationServer, OAuthError } from "@cloudflare/workers-oauth-provider";
import { companyCredential, companyOAuth } from "@platform/auth-proxy/company-oauth";
import { sessionVersion } from "@platform/auth-proxy/configuration";
import { issuer } from "@platform/auth-proxy/identity";
import { readAuthConfiguration } from "@platform/auth-proxy/worker";
import { decodeMcpLogin, mcpLoginKey } from "@platform/auth-proxy/mcp-login";
import { mcpClaims, mcpScopes, organizationIdentifier } from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { readOrganizationAvailability } from "./availability.ts";
import { mcpOAuthStorage } from "./mcp-grants.ts";
import { appUserAnalytics } from "./app-user-analytics.ts";

export const mcpGrant = z.object({
  organizationId: organizationIdentifier,
  provider: z.enum(["google", "microsoft"]).optional(),
  credential: companyCredential,
});

export const mcpAccess = mcpClaims.shape.mcp.extend({
  version: z.string(),
  expiresAt: z.number(),
  provider: mcpGrant.shape.provider,
});

export const readMcpConfiguration = (environment: ParentEnvironment) => {
  if (!environment.WIDEFLEET_MCP_ORIGIN) return null;
  const url = new URL(environment.WIDEFLEET_MCP_ORIGIN);

  if (
    url.protocol !== "https:" ||
    url.href !== `${url.origin}/` ||
    !url.hostname.startsWith("mcp.")
  )
    throw new Error("MCP requires its configured HTTPS origin");

  return { issuer: url.origin, resource: `${url.origin}/mcp` };
};

export const readMcpLogin = async (environment: ParentEnvironment) => {
  const value = await environment.AUTH_CONFIG.get(mcpLoginKey);
  const location = readMcpConfiguration(environment);

  if (!value || !location) throw new Error("MCP sign-in is not configured");
  const configuration = await decodeMcpLogin(environment.WIDEFLEET_CONTROL_TOKEN, value);

  if (configuration.origin !== location.issuer)
    throw new Error("MCP sign-in belongs to another installation");

  return configuration;
};

export const findMcpOrganization = async (
  environment: ParentEnvironment,
  organizationId: string,
) => {
  const installed = await readAuthConfiguration(environment, organizationId);
  const location = readMcpConfiguration(environment);

  if (!installed || !location) return null;
  const origin = new URL(installed.configuration.redirectUrl);
  origin.hostname = `mcp.${installed.configuration.domain}`;

  if (origin.origin !== location.issuer) return null;
  const availability = await readOrganizationAvailability(environment, organizationId);

  if (availability === null) throw new Error("Organization availability could not be read");

  return availability.blocked ? null : installed.configuration;
};

export const readMcpOrganization = async (
  environment: ParentEnvironment,
  organizationId: string,
) => {
  const configuration = await findMcpOrganization(environment, organizationId);

  if (!configuration)
    throw new OAuthError("invalid_grant", {
      description: "Company authorization is no longer valid",
    });

  return configuration;
};

export const readMcpCompanyConfiguration = async (
  environment: ParentEnvironment,
  organizationId: string,
  provider?: "google" | "microsoft",
) => {
  // Earlier releases completed some grants through Widefleet-owned Google and
  // Microsoft registrations. Only the organization's registration is trusted now.
  if (provider)
    throw new OAuthError("invalid_grant", { description: "Company sign-in has changed" });

  return readMcpOrganization(environment, organizationId);
};

// Every MCP access token is bounded by the company authorization it carries.
const accessTokenTTL = 300;

export const mcpAuthorizationServer = (environment: ParentEnvironment) => {
  const location = readMcpConfiguration(environment);

  if (!location) throw new Error("MCP is not configured");

  // The OAuth library owns client:, grant:, token: and transaction keys. App
  // configuration uses organizations/ and apps/ in the same installed KV store.
  const storage = { OAUTH_KV: mcpOAuthStorage(environment) };

  const server = new OAuthAuthorizationServer({
    issuer: location.issuer,
    resources: [location.resource],
    defaultResource: location.resource,
    scopesSupported: mcpScopes,
    clientRegistrationEndpoint: "/oauth/register",
    allowTokenExchangeGrant: false,
    accessTokenTTL,
    tokenExchangeCallback: async ({ props, grantType }) => {
      const grant = mcpGrant.parse(props);

      const configuration = await readMcpCompanyConfiguration(
        environment,
        grant.organizationId,
        grant.provider,
      );

      if (grant.credential.version !== (await sessionVersion(configuration)))
        throw new OAuthError("invalid_grant", {
          description: "Company authorization is no longer valid",
        });
      let credential = grant.credential;
      let renewed = false;

      // Renew at the provider only when the verified authorization can no longer
      // cover a full access token. Clients that refresh early receive a token from
      // the authorization they already have.
      if (
        grantType === "refresh_token" &&
        credential.authorization.expiresAt - Date.now() < accessTokenTTL * 1000
      ) {
        const renewal = await companyOAuth(configuration)
          .then((company) => company.renew(credential))
          .catch((cause: unknown) => {
            // Renewal reports provider failures as results; anything thrown here is
            // unexpected and must not end the grant.
            console.error("MCP company authorization renewal failed", {
              error: cause instanceof Error ? cause.name : "UnknownError",
              message: cause instanceof Error ? cause.message.slice(0, 300) : undefined,
            });

            return { status: "unavailable", credential: undefined } as const;
          });

        if (renewal.status === "unavailable")
          throw new OAuthError("temporarily_unavailable", {
            description: "Company sign-in is temporarily unavailable",
            statusCode: 503,
            retryProps: renewal.credential
              ? { ...grant, credential: renewal.credential }
              : undefined,
          });

        if (renewal.status !== "renewed")
          throw new OAuthError("invalid_grant", {
            description:
              renewal.status === "denied"
                ? "Company access was denied"
                : "Company authorization is no longer valid",
          });
        credential = renewal.credential;
        renewed = true;
      }

      const ttl = Math.min(
        accessTokenTTL,
        Math.floor((credential.authorization.expiresAt - Date.now()) / 1000),
      );

      // KV expiration has a 60-second minimum. Never extend the verified identity
      // to satisfy it. Only a provider authorization that is already this short
      // when verified reaches this point.
      if (ttl < 60)
        throw new OAuthError("invalid_grant", {
          description: "Company authorization is no longer valid",
        });
      const identity = credential.authorization.identity;

      // Like app sessions, only a sign-in or a renewal at the provider proves the
      // identity again; tokens from an existing authorization are not activity.
      if (renewed || grantType !== "refresh_token")
        appUserAnalytics(environment)?.({
          trigger: renewed ? "mcp_renewal" : "mcp_sign_in",
          organizationId: grant.organizationId,
          issuer: issuer(configuration.provider),
          identity,
        });

      const result = {
        newProps: { ...grant, credential },
        accessTokenProps: mcpAccess.parse({
          organizationId: grant.organizationId,
          provider: grant.provider,
          identity: {
            issuer: issuer(configuration.provider),
            subject: identity.id,
            name: identity.name,
            groups: identity.groups,
          },
          version: credential.version,
          expiresAt: credential.authorization.expiresAt,
        }),
        accessTokenTTL: ttl,
      };

      return credential.refreshToken ? result : { ...result, refreshTokenTTL: 0 };
    },
  });

  return { server, storage, oauth: server.getOAuthApi(storage), ...location };
};
