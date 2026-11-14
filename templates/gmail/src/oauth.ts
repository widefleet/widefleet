import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";

const tokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  accessTokenExpiresAt: z.date().optional(),
  refreshTokenExpiresAt: z.date().optional(),
  scopes: z.array(z.string()),
  tokenType: z.string(),
});

type Provider = "google" | "github" | "microsoft";

type Request =
  | { action: "configuration"; provider: Provider }
  | { action: "authorize"; provider: Provider; state: string; codeChallenge: string }
  | { action: "exchange"; provider: Provider; ticket: string; code: string; codeVerifier: string }
  | { action: "refresh"; provider: Provider; refreshToken: string };

export type OAuthBinding = {
  request(
    input: Request,
  ): Promise<{ clientId: string } | { url: string } | z.infer<typeof tokens> | null>;
};

export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
  authSecret: string;
  managed: boolean;
};

type Environment = {
  WIDEFLEET_OAUTH?: OAuthBinding;
  WIDEFLEET_SECRETS: { get(name: string): Promise<string> };
};

export const oauthCredentials = async (
  environment: Environment,
  provider: Provider,
  prefix: string,
) => {
  const read = async (name: string) => {
    try {
      return await environment.WIDEFLEET_SECRETS.get(name);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith("App secret is not configured"))
        throw error;

      return "";
    }
  };

  const clientId = await read(`${prefix}_CLIENT_ID`);
  const clientSecret = await read(`${prefix}_CLIENT_SECRET`);
  const authSecret = await read("AUTH_SECRET");
  const missing: string[] = [];

  if (!authSecret) missing.push("AUTH_SECRET");

  // A partial custom registration is a configuration error, never a fallback.
  if (clientId || clientSecret) {
    if (!clientSecret) missing.unshift(`${prefix}_CLIENT_SECRET`);

    if (!clientId) missing.unshift(`${prefix}_CLIENT_ID`);

    return { missing, credentials: { clientId, clientSecret, authSecret, managed: false } };
  }

  const managed = environment.WIDEFLEET_OAUTH
    ? await environment.WIDEFLEET_OAUTH.request({ action: "configuration", provider })
    : null;

  if (managed)
    return {
      missing,
      credentials: {
        clientId: z.object({ clientId: z.string().min(1) }).parse(managed).clientId,
        clientSecret: "",
        authSecret,
        managed: true,
      },
    };
  missing.unshift(`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`);

  return { missing, credentials: { clientId, clientSecret, authSecret, managed: false } };
};

// Kept inside each standalone template so copying its directory needs no workspace package.
export const managedOAuthPlugin = (
  binding: OAuthBinding,
  id: Provider,
  ticket?: string,
): BetterAuthPlugin => ({
  id: "widefleet-managed-oauth",
  init(context) {
    const provider = context.socialProviders.find((candidate) => candidate.id === id);

    if (!provider) throw new Error("OAuth provider is not initialized");
    provider.createAuthorizationURL = async ({ state, codeVerifier }) => {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
      );

      const codeChallenge = btoa(String.fromCharCode(...digest))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");

      const result = await binding.request({
        action: "authorize",
        provider: id,
        state,
        codeChallenge,
      });

      return new URL(z.object({ url: z.url() }).parse(result).url);
    };

    provider.validateAuthorizationCode = async ({ code, codeVerifier }) => {
      if (!ticket || !codeVerifier)
        throw new Error("Managed OAuth callback is missing its transaction");

      return tokens.parse(
        await binding.request({ action: "exchange", provider: id, ticket, code, codeVerifier }),
      );
    };

    provider.refreshAccessToken = async (refreshToken) =>
      tokens.parse(await binding.request({ action: "refresh", provider: id, refreshToken }));
  },
});
