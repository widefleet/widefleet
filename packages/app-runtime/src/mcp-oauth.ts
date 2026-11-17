import { OAuthAuthorizationServer, OAuthError } from "@cloudflare/workers-oauth-provider";
import {
  companyCredential,
  companyOAuth,
  CompanyRefreshFailure,
} from "@platform/auth-proxy/company-oauth";
import { sessionVersion } from "@platform/auth-proxy/configuration";
import { issuer } from "@platform/auth-proxy/identity";
import { readAuthConfiguration } from "@platform/auth-proxy/worker";
import { decodeMcpLogin, mcpLoginKey } from "@platform/auth-proxy/mcp-login";
import { mcpClaims, mcpScopes, organizationIdentifier } from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { readOrganizationAvailability } from "./availability.ts";

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
  const configuration = await readMcpOrganization(environment, organizationId);

  if (!provider) return configuration;
  const login = await readMcpLogin(environment);
  const registration = login[provider];

  if (
    !registration ||
    (provider === "google"
      ? configuration.provider.type !== "google"
      : configuration.provider.type !== "entra")
  )
    throw new OAuthError("invalid_grant", { description: "Company sign-in has changed" });

  return {
    ...configuration,
    ...registration,
    redirectUrl: `${login.origin}/oauth/callback/${provider}`,
  };
};

const failure = z.object({ error: z.string().optional() });

export const mcpAuthorizationServer = (environment: ParentEnvironment) => {
  const location = readMcpConfiguration(environment);

  if (!location) throw new Error("MCP is not configured");

  // The OAuth library owns client:, grant:, token: and transaction keys. App
  // configuration uses organizations/ and apps/ in the same installed KV store.
  const storage = { OAUTH_KV: environment.AUTH_CONFIG };

  const server = new OAuthAuthorizationServer({
    issuer: location.issuer,
    resources: [location.resource],
    defaultResource: location.resource,
    scopesSupported: mcpScopes,
    clientRegistrationEndpoint: "/oauth/register",
    allowTokenExchangeGrant: false,
    accessTokenTTL: 300,
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

      if (grantType === "refresh_token") {
        if (
          !credential.refreshToken ||
          (credential.refreshExpiresAt !== undefined && credential.refreshExpiresAt <= Date.now())
        )
          throw new OAuthError("invalid_grant", {
            description: "Company authorization is no longer valid",
          });

        try {
          credential = await (await companyOAuth(configuration)).refresh(credential);
        } catch (cause) {
          const details = failure.safeParse(
            cause instanceof CompanyRefreshFailure ? cause.cause : cause,
          );

          const terminal = details.success && details.data.error === "invalid_grant";

          throw new OAuthError(terminal ? "invalid_grant" : "temporarily_unavailable", {
            description: "Company sign-in could not be refreshed",
            statusCode: terminal ? 400 : 503,
            retryProps:
              !terminal && cause instanceof CompanyRefreshFailure
                ? { ...grant, credential: cause.credential }
                : undefined,
          });
        }
      }

      const ttl = Math.min(
        300,
        Math.floor((credential.authorization.expiresAt - Date.now()) / 1000),
      );

      // KV expiration has a 60-second minimum. Never extend the verified identity
      // to satisfy it: the client must obtain a fresh company authorization.
      if (ttl < 60)
        throw new OAuthError("invalid_grant", {
          description: "Company authorization is no longer valid",
        });
      const identity = credential.authorization.identity;

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
