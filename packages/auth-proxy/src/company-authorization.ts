import { APIError } from "better-auth/api";
import type { OAuth2Tokens, OAuthProvider } from "better-auth/oauth2";
import { decodeProtectedHeader } from "jose";
import { z } from "zod";
import { proxyIdentity } from "./identity.ts";

// What Widefleet last verified about a person at their company provider. Browser
// sessions and MCP grants both renew it through renewCompanyAuthorization.
export const authorization = z.object({
  identity: proxyIdentity,
  subject: z.string().min(1),
  nonce: z.string().optional(),
  expiresAt: z.number().finite().positive(),
});

export type CompanyAuthorization = z.infer<typeof authorization>;

// The provider credential that renews an authorization. Providers may rotate it on
// every refresh, so callers persist the one returned with each result.
export interface CompanyCredential {
  refreshToken: string;
  refreshExpiresAt?: number | undefined;
  scopes?: string[] | undefined;
}

export type CompanyRenewal =
  | { status: "renewed"; authorization: CompanyAuthorization; credential: CompanyCredential }
  // The provider or a lookup it depends on did not answer. The previous
  // authorization stays as it was; retrying later can succeed.
  | { status: "unavailable"; credential?: CompanyCredential; retryAfter?: string }
  // The provider refused the person. A new sign-in would be refused as well.
  | { status: "denied"; credential?: CompanyCredential }
  // The credential or identity is no longer valid; only a new sign-in can help.
  | { status: "sign-in-required" };

class CompanySignInRequired extends Error {}

class SigningKeysUnavailable extends Error {}

// jose codes for a key set that could not be downloaded or read. Every other key
// resolution failure, such as no key for the token, is a property of the token.
const keySetOutages = new Set(["ERR_JWKS_TIMEOUT", "ERR_JOSE_GENERIC", "ERR_JWKS_INVALID"]);

const joseFailure = z.object({ code: z.string() });

const tokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.date().optional(),
  refreshTokenExpiresAt: z.date().optional(),
  scopes: z.array(z.string()).optional(),
  tokenType: z.string().optional(),
});

const tokenFailure = z.object({ error: z.string().optional(), status: z.number().optional() });

// Logs error codes and messages only, never tokens or claims.
export const failureSummary = (cause: unknown) => {
  const failure = tokenFailure.safeParse(cause);

  return {
    type: cause instanceof Error ? cause.name : "non-error",
    message: cause instanceof Error ? cause.message.slice(0, 300) : undefined,
    status: failure.success ? failure.data.status : undefined,
    error: failure.success ? failure.data.error : undefined,
  };
};

const logFailure = (stage: string, cause?: unknown) =>
  console.error(
    "Company authorization renewal failed",
    cause === undefined ? { stage } : { stage, ...failureSummary(cause) },
  );

// Better Auth reports every failed ID token verification as `false`, including a
// signing-key download that timed out. Resolving the key first separates a provider
// outage from an invalid token. Better Auth's resolver caches the key set, so its
// own verification reuses the key resolved here.
const resolveSigningKey = async (provider: OAuthProvider, idToken: string) => {
  const config = provider.idToken;

  if (!config || !("jwks" in config)) return;
  const [encodedHeader = "", payload = "", signature = ""] = idToken.split(".");
  let header: ReturnType<typeof decodeProtectedHeader>;

  try {
    header = decodeProtectedHeader(idToken);
  } catch {
    throw new CompanySignInRequired("The company ID token is malformed");
  }

  const { alg } = header;

  if (!alg) throw new CompanySignInRequired("The company ID token names no algorithm");

  try {
    await config.jwks({ ...header, alg }, { protected: encodedHeader, payload, signature });
  } catch (cause) {
    const failure = joseFailure.safeParse(cause);

    // A download that fails before jose sees a response surfaces as a fetch error.
    if (!failure.success || keySetOutages.has(failure.data.code))
      throw new SigningKeysUnavailable(
        `Company signing keys are unavailable (${failure.success ? failure.data.code : "network"})`,
        { cause },
      );

    throw new CompanySignInRequired(
      `The company ID token has no usable key (${failure.data.code})`,
    );
  }
};

// Verifies a provider token response and returns the authorization it proves.
// `verified` reads what the provider's getUserInfo recorded for this response.
export const verifyCompanyIdentity = async (
  provider: OAuthProvider,
  verified: () => CompanyAuthorization | undefined,
  response: OAuth2Tokens & { expectedIdTokenNonce?: string },
) => {
  if (!response.idToken)
    throw new CompanySignInRequired("The provider returned no ID token to verify");
  await resolveSigningKey(provider, response.idToken);

  if (!(await provider.getUserInfo(response)))
    throw new CompanySignInRequired("Company identity could not be verified");
  const current = authorization.safeParse(verified());

  if (!current.success || current.data.expiresAt <= Date.now())
    throw new CompanySignInRequired("Company identity could not be verified");

  return current.data;
};

const identityFailure = (cause: unknown, credential: CompanyCredential): CompanyRenewal => {
  if (cause instanceof CompanySignInRequired) return { status: "sign-in-required" };

  if (cause instanceof APIError) {
    if (cause.statusCode === 403) return { status: "denied", credential };

    if (cause.statusCode === 429 || cause.statusCode >= 500) {
      const retryAfter = new Headers(cause.headers).get("retry-after");

      return retryAfter
        ? { status: "unavailable", credential, retryAfter }
        : { status: "unavailable", credential };
    }

    return { status: "sign-in-required" };
  }

  // Key and directory outages, and unexpected failures, keep the authorization.
  return { status: "unavailable", credential };
};

const refreshFailure = (cause: unknown): CompanyRenewal => {
  const failure = failureSummary(cause);

  if (failure.error === "invalid_grant") return { status: "sign-in-required" };

  if (failure.error === "temporarily_unavailable") return { status: "unavailable" };

  if (failure.status === 403) return { status: "denied" };

  // Keep the authorization through outages, timeouts and rate limits. Any other
  // provider rejection or malformed token response fails again on retry; a new
  // sign-in can still succeed, so it must not leave the person stuck.
  if (
    cause instanceof z.ZodError ||
    (failure.status !== undefined &&
      failure.status >= 400 &&
      failure.status < 500 &&
      failure.status !== 408 &&
      failure.status !== 429)
  )
    return { status: "sign-in-required" };

  return { status: "unavailable" };
};

// Only overlapping requests in this isolate share work. No state is kept here.
const pending = new Map<string, Promise<z.infer<typeof tokens>>>();

const refreshTogether = async (key: string, refresh: () => Promise<z.infer<typeof tokens>>) => {
  const existing = pending.get(key);

  if (existing) return existing;

  const result = refresh();
  pending.set(key, result);

  try {
    return await result;
  } finally {
    pending.delete(key);
  }
};

const exchange = (
  provider: OAuthProvider,
  refresh: NonNullable<OAuthProvider["refreshAccessToken"]>,
  refreshToken: string,
  context: Parameters<NonNullable<OAuthProvider["refreshAccessToken"]>>[1],
) =>
  refreshTogether(JSON.stringify([provider.issuer, refreshToken]), async () => {
    try {
      return tokens.parse(await refresh(refreshToken, context));
    } catch (cause) {
      const failure = tokenFailure.safeParse(cause);

      // Another request may still be committing the provider's rotation replay
      // response. Retry once before requiring a fresh sign-in.
      if (!failure.success || failure.data.error !== "invalid_grant") throw cause;
      await new Promise((resolve) => setTimeout(resolve, 100));

      return tokens.parse(await refresh(refreshToken, context));
    }
  });

// Renews an expiring authorization at the company provider. The caller decides when
// renewal is due, persists the returned credential and maps the result to its
// protocol. The previous authorization never gains time without a verified identity.
export const renewCompanyAuthorization = async (
  // Absent when provider discovery failed for this request.
  provider: OAuthProvider | undefined,
  verified: () => CompanyAuthorization | undefined,
  previous: CompanyAuthorization,
  credential: {
    refreshToken?: string | undefined;
    refreshExpiresAt?: number | undefined;
    scopes?: string[] | undefined;
  },
  context?: Parameters<NonNullable<OAuthProvider["refreshAccessToken"]>>[1],
): Promise<CompanyRenewal> => {
  const { refreshToken } = credential;

  if (
    !refreshToken ||
    (credential.refreshExpiresAt !== undefined && credential.refreshExpiresAt <= Date.now())
  )
    return { status: "sign-in-required" };

  if (!provider?.refreshAccessToken) {
    logFailure("discovery");

    return { status: "unavailable" };
  }

  let response: z.infer<typeof tokens>;

  try {
    response = await exchange(provider, provider.refreshAccessToken, refreshToken, context);
  } catch (cause) {
    logFailure("refresh", cause);

    return refreshFailure(cause);
  }

  // An omitted refresh scope inherits the original grant (OAuth 2.0 §6).
  const scopes = response.scopes?.length ? response.scopes : credential.scopes;

  const replacement = {
    refreshToken: response.refreshToken ?? refreshToken,
    refreshExpiresAt: response.refreshTokenExpiresAt?.getTime() ?? credential.refreshExpiresAt,
    scopes,
  };

  let current: CompanyAuthorization;

  try {
    current = await verifyCompanyIdentity(provider, verified, { ...response, scopes });
  } catch (cause) {
    logFailure("identity", cause);

    return identityFailure(cause, replacement);
  }

  if (
    current.subject !== previous.subject ||
    current.identity.id !== previous.identity.id ||
    (current.nonce !== undefined && current.nonce !== previous.nonce)
  ) {
    logFailure("verification");

    return { status: "sign-in-required" };
  }

  return {
    status: "renewed",
    authorization: { ...current, nonce: previous.nonce },
    credential: replacement,
  };
};
