import { z } from "zod";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { validateAuthorizationCode } from "better-auth/oauth2";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Caller, Environment } from "./context.ts";
import { ensureUser } from "./database.ts";

/**
 * The scopes the offered methods need: reading all of the athlete's profile,
 * activities, routes and segments, including private ones, and creating and
 * changing activities and starred segments.
 */
export const scopes = [
  "read",
  "read_all",
  "profile:read_all",
  "profile:write",
  "activity:read_all",
  "activity:write",
] as const;

/** The organization's own Strava API application. */
export type OAuthCredentials = { clientId: string; clientSecret: string };

const tokenEndpoint = "https://www.strava.com/api/v3/oauth/token";

// The token answer carries a summary of the athlete who authorized.
const athlete = z.object({
  athlete: z.object({
    id: z.number(),
    username: z.string().nullish(),
    firstname: z.string().nullish(),
    lastname: z.string().nullish(),
  }),
});

/**
 * Better Auth for one Widefleet user. `granted` is the `scope` of Strava's
 * callback: the scopes the athlete granted, which Strava's token answer leaves out.
 */
export const authentication = (
  environment: Environment,
  identity: Caller,
  id: string,
  credentials: OAuthCredentials,
  granted = "",
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
      additionalFields: { providerName: { type: "string", required: false } },
      validateUserInfo: async ({ user, source }) => {
        if (
          source.action !== "link-account" ||
          user.id !== id ||
          source.oauth?.providerId !== "strava"
        )
          return { error: "invalid_linking_user" };

        const accountId = z.object({ id: z.string().min(1) }).parse(source.oauth.profile).id;

        const saved = await environment.DB.prepare(
          "SELECT accountId FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, "strava")
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
        trustedProviders: ["strava"],
      },
    },
    advanced: { cookiePrefix: "account_strava" },
    plugins: [
      // Better Auth has no Strava provider; Strava's OAuth is plain OAuth 2.0.
      genericOAuth({
        config: [
          {
            providerId: "strava",
            name: "Strava",
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            authorizationUrl: "https://www.strava.com/oauth/authorize",
            tokenUrl: tokenEndpoint,
            // Strava separates scopes with commas and documents no PKCE.
            scopes: [scopes.join(",")],
            pkce: false,
            disableSignUp: true,
            getToken: async ({ code, redirectURI }) => ({
              ...(await validateAuthorizationCode({
                code,
                redirectURI,
                options: { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
                tokenEndpoint,
              })),
              scopes: granted.split(",").filter(Boolean),
            }),
            getUserInfo: async (tokens) => {
              const { athlete: profile } = athlete.parse(tokens.raw);
              const name = [profile.firstname, profile.lastname].filter(Boolean).join(" ");

              return {
                id: String(profile.id),
                name: name || undefined,
                username: profile.username,
                emailVerified: false,
              };
            },
            mapProfileToUser: (profile) => ({
              providerName: z.string().nullish().parse(profile["username"]) || profile.name,
            }),
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
