import { z } from "zod";
import { createAuthentication } from "./authentication.ts";
import {
  authorization,
  renewCompanyAuthorization,
  verifyCompanyIdentity,
  type CompanyAuthorization,
  type CompanyCredential,
} from "./company-authorization.ts";
import { type AuthConfiguration, sessionVersion } from "./configuration.ts";
import { issuer } from "./identity.ts";

// MCP uses the same provider verification and directory lookup as app sign-in,
// but owns a separate upstream grant rather than copying an app's rotating cookie.
export const companyCredential = z.object({
  authorization,
  version: z.string(),
  refreshToken: z.string().optional(),
  refreshExpiresAt: z.number().optional(),
  scopes: z.array(z.string()).optional(),
});

export const companyTokens = z.object({
  accessToken: z.string().min(1),
  idToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.coerce.date().optional(),
  refreshTokenExpiresAt: z.coerce.date().optional(),
  scopes: z.array(z.string()).optional(),
  tokenType: z.string().optional(),
});

export const companySession = async (configuration: AuthConfiguration, headers: Headers) => {
  const auth = await createAuthentication(configuration, false);
  const session = await auth.api.getSession({ headers });
  const current = authorization.safeParse(session?.user.appAuthorization);

  return current.success && current.data.expiresAt > Date.now() ? current.data.identity : null;
};

export const companyOAuth = async (configuration: AuthConfiguration) => {
  let verified: CompanyAuthorization | undefined;

  const auth = await createAuthentication(configuration, true, (value) => {
    verified = value;
  });

  const context = await auth.$context;
  // Better Auth skips a provider whose discovery failed. Renewal reports that as an
  // outage; sign-in cannot start without it.
  const provider = context.socialProviders.find((candidate) => candidate.id === "company");

  const signIn = () => {
    if (!provider) throw new Error("Company sign-in is unavailable");

    return provider;
  };

  const version = await sessionVersion(configuration);

  const identify = async (tokens: z.infer<typeof companyTokens>, nonce: string) => {
    const current = await verifyCompanyIdentity(signIn(), () => verified, {
      ...tokens,
      expectedIdTokenNonce: nonce,
    });

    return companyCredential.parse({
      authorization: current,
      version,
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: tokens.refreshTokenExpiresAt?.getTime(),
      scopes: tokens.scopes,
    });
  };

  return {
    issuer: issuer(configuration.provider),
    version,
    identify,
    authorize: async (state: string, verifier: string, nonce: string, loginHint?: string) =>
      signIn().createAuthorizationURL({
        state,
        codeVerifier: verifier,
        idTokenNonce: nonce,
        redirectURI: configuration.redirectUrl,
        loginHint,
      }),
    exchange: async (code: string, verifier: string, nonce: string) =>
      identify(
        companyTokens.parse(
          await signIn().validateAuthorizationCode({
            code,
            codeVerifier: verifier,
            redirectURI: configuration.redirectUrl,
          }),
        ),
        nonce,
      ),
    // Renews the grant's company authorization. A returned credential replaces the
    // grant's credential, even when the authorization itself was not renewed.
    renew: async (previous: z.infer<typeof companyCredential>) => {
      if (previous.version !== version) return { status: "sign-in-required" } as const;

      const renewal = await renewCompanyAuthorization(
        provider,
        () => verified,
        previous.authorization,
        previous,
      );

      const grant = (credential: CompanyCredential, current = previous.authorization) =>
        companyCredential.parse({ ...previous, ...credential, authorization: current });

      switch (renewal.status) {
        case "renewed":
          return {
            status: renewal.status,
            credential: grant(renewal.credential, renewal.authorization),
          };
        case "unavailable":
        case "denied":
          return {
            status: renewal.status,
            credential: renewal.credential && grant(renewal.credential),
          };
        default:
          return renewal;
      }
    },
  };
};
