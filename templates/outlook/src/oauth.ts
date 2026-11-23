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

// The operator's managed client for each provider and the scopes this
// connector requests from it.
const clients = {
  google: {
    client: "google",
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly"],
  },
  github: { client: "github", scopes: ["read:user", "user:email", "repo"] },
  microsoft: {
    client: "microsoft",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
      "Contacts.ReadWrite",
      "MailboxSettings.ReadWrite",
    ],
  },
  linear: { client: "linear", scopes: ["read", "write"] },
} as const;

type Provider = keyof typeof clients;

type Request =
  | { action: "configuration"; client: string }
  | { action: "authorize"; client: string; scopes: string[]; state: string; codeVerifier: string }
  | { action: "exchange"; client: string; ticket: string; code: string; codeVerifier: string }
  | { action: "refresh"; client: string; refreshToken: string }
  | { action: "revoke"; client: string; token: string };

export type OAuthBinding = {
  request(
    input: Request,
  ): Promise<
    { clientId: string } | { url: string } | z.infer<typeof tokens> | { revoked: boolean } | null
  >;
};

export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
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
  const missing: string[] = [];

  // A partial custom registration is a configuration error, never a fallback.
  if (clientId || clientSecret) {
    if (!clientSecret) missing.unshift(`${prefix}_CLIENT_SECRET`);

    if (!clientId) missing.unshift(`${prefix}_CLIENT_ID`);

    return { missing, credentials: { clientId, clientSecret, managed: false } };
  }

  const managed = environment.WIDEFLEET_OAUTH
    ? await environment.WIDEFLEET_OAUTH.request({
        action: "configuration",
        client: clients[provider].client,
      })
    : null;

  if (managed)
    return {
      missing,
      credentials: {
        clientId: z.object({ clientId: z.string().min(1) }).parse(managed).clientId,
        clientSecret: "",
        managed: true,
      },
    };
  missing.unshift(`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`);

  return { missing, credentials: { clientId, clientSecret, managed: false } };
};

/** Revokes a managed grant at the provider, when its client supports revocation. */
export const revokeManagedGrant = async (binding: OAuthBinding, id: Provider, token: string) => {
  await binding.request({ action: "revoke", client: clients[id].client, token });
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
    // Managed access tokens are placeholders; the Widefleet network gateway
    // sends the real token only to the operator's API hosts.
    provider.createAuthorizationURL = async ({ state, codeVerifier }) => {
      const result = await binding.request({
        action: "authorize",
        client: clients[id].client,
        scopes: [...clients[id].scopes],
        state,
        codeVerifier,
      });

      return new URL(z.object({ url: z.url() }).parse(result).url);
    };

    provider.validateAuthorizationCode = async ({ code, codeVerifier }) => {
      if (!ticket || !codeVerifier)
        throw new Error("Managed OAuth callback is missing its transaction");

      return tokens.parse(
        await binding.request({
          action: "exchange",
          client: clients[id].client,
          ticket,
          code,
          codeVerifier,
        }),
      );
    };

    provider.refreshAccessToken = async (refreshToken) =>
      tokens.parse(
        await binding.request({ action: "refresh", client: clients[id].client, refreshToken }),
      );
  },
});
