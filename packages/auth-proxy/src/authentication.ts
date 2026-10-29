import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth/minimal";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { z } from "zod";
import { sessionVersion, type AuthConfiguration } from "./configuration.ts";
import { issuer, providerIdentity, proxyIdentity } from "./identity.ts";

export const cookiePrefix = (configuration: AuthConfiguration) =>
  `platform_sso_${configuration.organizationId}`;

export const companyCookie = (name: string) =>
  name.replace(/^(?:__Secure-|__Host-)/, "").startsWith("platform_sso_");

const authenticationOptions = async (configuration: AuthConfiguration) =>
  ({
    appName: "Widefleet Auth Proxy",
    baseURL: new URL(configuration.redirectUrl).origin,
    basePath: `/oauth2/${configuration.organizationId}`,
    secret: configuration.cookieSecret,
    trustedOrigins: [
      new URL(configuration.redirectUrl).origin,
      `https://*.${configuration.domain}${new URL(configuration.redirectUrl).port ? `:${new URL(configuration.redirectUrl).port}` : ""}`,
    ],
    account: {
      storeStateStrategy: "cookie",
      storeAccountCookie: false,
      accountLinking: { enabled: false },
    },
    session: {
      expiresIn: 3600,
      disableSessionRefresh: true,
      cookieCache: {
        enabled: true,
        strategy: "jwe",
        maxAge: 3600,
        refreshCache: false,
        version: await sessionVersion(configuration),
      },
    },
    user: {
      additionalFields: {
        appIdentity: { type: "json", required: false, input: false },
      },
    },
    advanced: {
      cookiePrefix: cookiePrefix(configuration),
      // Explicit prefixes let the OAuth state use __Host-; Better Auth otherwise
      // prepends __Secure- to every cookie name. All cookies remain Secure.
      useSecureCookies: false,
      defaultCookieAttributes: { secure: true },
      crossSubDomainCookies: { enabled: false },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      cookies: {
        // Login state belongs to the auth host, while sessions are shared by apps.
        oauth_state: {
          name: `__Host-${cookiePrefix(configuration)}.oauth_state`,
          attributes: { maxAge: 300 },
        },
        session_token: {
          name: `__Secure-${cookiePrefix(configuration)}.session_token`,
          attributes: { domain: configuration.domain },
        },
        session_data: {
          name: `__Secure-${cookiePrefix(configuration)}.session_data`,
          attributes: { domain: configuration.domain },
        },
      },
    },
  }) satisfies BetterAuthOptions;

export const createAuthentication = async (configuration: AuthConfiguration, login: boolean) => {
  const options = await authenticationOptions(configuration);
  let identity: z.infer<typeof proxyIdentity> | undefined;

  // A new instance per request keeps Better Auth's temporary in-memory records
  // out of subsequent logins. Session checks do not initialize OIDC discovery.
  return betterAuth({
    ...options,
    plugins: login
      ? [
          genericOAuth({
            config: [
              {
                providerId: "company",
                clientId: configuration.clientId,
                clientSecret: configuration.clientSecret,
                discoveryUrl: `${issuer(configuration.provider)}/.well-known/openid-configuration`,
                // Only Widefleet needs the form-origin check; Entra rejects Origin
                // on confidential-client token requests.
                authorizationHeaders:
                  configuration.provider.type === "oidc" &&
                  configuration.provider.sendTokenRequestOrigin
                    ? { origin: new URL(issuer(configuration.provider)).origin }
                    : undefined,
                requireIdTokenVerification: true,
                redirectURI: configuration.redirectUrl,
                disableProviderLogout: true,
                scopes: [
                  ...new Set([
                    "openid",
                    "profile",
                    "email",
                    ...(configuration.scopes ?? []),
                    ...(configuration.provider.type === "entra" ? ["User.Read"] : []),
                  ]),
                ],
                getUserInfo: async (tokens) => {
                  if (!tokens.idToken) return null;

                  const result = await providerIdentity(
                    configuration.provider,
                    tokens.idToken,
                    tokens.accessToken,
                    configuration.organizationId,
                  );

                  identity = result.identity;

                  return {
                    ...result.claims,
                    name: identity.name,
                    email: identity.email,
                    emailVerified: true,
                  };
                },
                accountSubject: () => proxyIdentity.parse(identity).id,
              },
            ],
          }),
        ]
      : [],
    databaseHooks: {
      user: {
        create: {
          before: (user) =>
            Promise.resolve({ data: { ...user, appIdentity: proxyIdentity.parse(identity) } }),
        },
      },
    },
  });
};
