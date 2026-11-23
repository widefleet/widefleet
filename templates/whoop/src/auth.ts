import { z } from "zod";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Caller, Environment } from "./context.ts";
import { ensureUser } from "./database.ts";

/**
 * The scopes the offered methods need: reading the member's profile, body
 * measurements, cycles, recoveries, sleeps and workouts, and `offline` for a
 * refresh token.
 */
export const scopes = [
  "offline",
  "read:profile",
  "read:body_measurement",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
] as const;

/** The organization's own WHOOP developer app. */
export type OAuthCredentials = { clientId: string; clientSecret: string };

// The member who authorized, from their basic profile.
const profile = z.object({
  user_id: z.number(),
  email: z.string(),
  first_name: z.string(),
  last_name: z.string(),
});

export const authentication = (
  environment: Environment,
  identity: Caller,
  id: string,
  credentials: OAuthCredentials,
) =>
  betterAuth({
    database: environment.DB,
    // Cookies are signed and saved tokens encrypted with the app's keys.
    keys: {
      sign: (value) => environment.WIDEFLEET_KEYS.sign("cookies", value),
      verify: (value, signature) => environment.WIDEFLEET_KEYS.verify("cookies", value, signature),
      encrypt: (value) => environment.WIDEFLEET_KEYS.encrypt("tokens", value),
      decrypt: async (value) =>
        new TextDecoder().decode(await environment.WIDEFLEET_KEYS.decrypt("tokens", value)),
    },
    baseURL: environment.WIDEFLEET_ORIGIN,
    basePath: "/auth",
    trustedOrigins: [environment.WIDEFLEET_ORIGIN],
    session: { expiresIn: 600, disableSessionRefresh: true },
    user: {
      additionalFields: { providerEmail: { type: "string", required: false } },
      validateUserInfo: async ({ user, source }) => {
        if (
          source.action !== "link-account" ||
          user.id !== id ||
          source.oauth?.providerId !== "whoop"
        )
          return { error: "invalid_linking_user" };

        const accountId = z.object({ id: z.string().min(1) }).parse(source.oauth.profile).id;

        const saved = await environment.DB.prepare(
          "SELECT accountId FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, "whoop")
          .first<string>("accountId");

        if (saved && saved !== accountId) return { error: "disconnect_before_switching_accounts" };

        return;
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeAccountCookie: false,
      storeStateStrategy: "database",
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: true,
        allowUnlinkingAll: true,
        updateUserInfoOnLink: true,
        trustedProviders: ["whoop"],
      },
    },
    advanced: { cookiePrefix: "account_whoop" },
    plugins: [
      // Better Auth has no WHOOP provider; WHOOP's OAuth is plain OAuth 2.0.
      genericOAuth({
        config: [
          {
            providerId: "whoop",
            name: "WHOOP",
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            authorizationUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
            tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
            scopes: [...scopes],
            // WHOOP's refresh requests name the offline scope.
            refreshTokenParams: { scope: "offline" },
            disableSignUp: true,
            getUserInfo: async (tokens) => {
              const response = await fetch(
                "https://api.prod.whoop.com/developer/v2/user/profile/basic",
                { headers: { authorization: `Bearer ${tokens.accessToken ?? ""}` } },
              );

              if (!response.ok) return null;
              const member = profile.parse(await response.json());

              return {
                id: String(member.user_id),
                name: `${member.first_name} ${member.last_name}`.trim(),
                email: member.email,
                emailVerified: false,
              };
            },
            mapProfileToUser: (member) => ({ providerEmail: member.email ?? undefined }),
          },
        ],
      }),
      {
        id: "widefleet-caller",
        endpoints: {
          establishSession: createAuthEndpoint(
            "/widefleet-session",
            { method: "POST" },
            async (ctx) => {
              // Only called by app code using the platform-verified caller. The synthetic
              // email satisfies Better Auth's schema and is never used for account linking.
              await ensureUser(environment.DB, id, identity.name);
              const user = await ctx.context.internalAdapter.findUserById(id);
              const session = await ctx.context.internalAdapter.createSession(id);

              if (!user || !session) throw ctx.error("INTERNAL_SERVER_ERROR");
              await setSessionCookie(ctx, { user, session });

              return ctx.json({ established: true });
            },
          ),
        },
      },
    ],
  });
