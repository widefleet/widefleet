import { z } from "zod";
import { createAuthentication } from "./authentication.ts";
import { type AuthConfiguration, sessionVersion } from "./configuration.ts";
import { issuer } from "./identity.ts";
import { authorization } from "./renewal.ts";

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

export class CompanySignInRequired extends Error {
  readonly error = "invalid_grant";
}

export class CompanyRefreshFailure extends Error {
  constructor(
    readonly credential: z.infer<typeof companyCredential>,
    cause: unknown,
  ) {
    super("Company identity could not be refreshed", { cause });
  }
}

export const companySession = async (configuration: AuthConfiguration, headers: Headers) => {
  const auth = await createAuthentication(configuration, false);
  const session = await auth.api.getSession({ headers });
  const current = authorization.safeParse(session?.user.appAuthorization);

  return current.success && current.data.expiresAt > Date.now() ? current.data.identity : null;
};

export const companyOAuth = async (configuration: AuthConfiguration) => {
  let verified: z.infer<typeof authorization> | undefined;

  const auth = await createAuthentication(configuration, true, (value) => {
    verified = value;
  });

  const context = await auth.$context;
  const provider = context.socialProviders.find((candidate) => candidate.id === "company");

  if (!provider) throw new Error("Company sign-in is unavailable");
  const version = await sessionVersion(configuration);

  const identify = async (
    tokens: Parameters<typeof provider.getUserInfo>[0],
    previous?: z.infer<typeof companyCredential>,
  ) => {
    verified = undefined;

    if (!tokens.idToken || !(await provider.getUserInfo(tokens)) || !verified)
      throw new CompanySignInRequired("Company identity could not be verified");
    const current = authorization.parse(verified);

    if (
      current.expiresAt <= Date.now() ||
      (previous &&
        (current.subject !== previous.authorization.subject ||
          current.identity.id !== previous.authorization.identity.id ||
          (current.nonce !== undefined && current.nonce !== previous.authorization.nonce)))
    )
      throw new CompanySignInRequired("Company identity changed or expired");

    return companyCredential.parse({
      authorization: { ...current, nonce: previous?.authorization.nonce ?? current.nonce },
      version,
      refreshToken: tokens.refreshToken ?? previous?.refreshToken,
      refreshExpiresAt: tokens.refreshTokenExpiresAt?.getTime() ?? previous?.refreshExpiresAt,
      scopes: tokens.scopes?.length ? tokens.scopes : previous?.scopes,
    });
  };

  return {
    issuer: issuer(configuration.provider),
    version,
    identify: (tokens: z.infer<typeof companyTokens>, nonce: string) =>
      identify({ ...tokens, expectedIdTokenNonce: nonce }),
    authorize: async (state: string, verifier: string, nonce: string, loginHint?: string) =>
      provider.createAuthorizationURL({
        state,
        codeVerifier: verifier,
        idTokenNonce: nonce,
        redirectURI: configuration.redirectUrl,
        loginHint,
      }),
    exchange: async (code: string, verifier: string, nonce: string) => {
      const tokens = await provider.validateAuthorizationCode({
        code,
        codeVerifier: verifier,
        redirectURI: configuration.redirectUrl,
      });

      return identify({ ...tokens, expectedIdTokenNonce: nonce });
    },
    refresh: async (previous: z.infer<typeof companyCredential>) => {
      if (
        previous.version !== version ||
        !previous.refreshToken ||
        (previous.refreshExpiresAt !== undefined && previous.refreshExpiresAt <= Date.now())
      )
        throw new CompanySignInRequired("Company sign-in must be renewed");

      if (!provider.refreshAccessToken) throw new Error("Company sign-in cannot be refreshed");
      const tokens = await provider.refreshAccessToken(previous.refreshToken);

      try {
        return await identify(
          {
            ...tokens,
            scopes: tokens.scopes?.length ? tokens.scopes : previous.scopes,
          },
          previous,
        );
      } catch (cause) {
        // Keep the replacement credential when a directory or key lookup fails.
        // The old verified identity and its deadline remain unchanged.
        throw new CompanyRefreshFailure(
          companyCredential.parse({
            ...previous,
            refreshToken: tokens.refreshToken ?? previous.refreshToken,
            refreshExpiresAt: tokens.refreshTokenExpiresAt?.getTime() ?? previous.refreshExpiresAt,
            scopes: tokens.scopes?.length ? tokens.scopes : previous.scopes,
          }),
          cause,
        );
      }
    },
  };
};
