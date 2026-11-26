import { z } from "zod";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { Caller, Environment } from "./context.ts";
import { ensureUser } from "./database.ts";

/**
 * Dataverse's Global Discovery Service, which lists the environments a user
 * can open. Each environment is its own resource with its own tokens.
 */
export const discovery = "https://globaldisco.crm.dynamics.com";

/**
 * The scopes the connection grants: signing in, refreshing without the user,
 * and acting as the user in Dataverse. Microsoft issues a token for one
 * resource at a time; the consent to impersonate the user covers every
 * environment's resource.
 */
export const scopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  `${discovery}/user_impersonation`,
] as const;

export const authentication = (
  environment: Environment,
  identity: Caller,
  id: string,
  credentials: { clientId: string; clientSecret: string },
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
          source.oauth?.providerId !== "microsoft"
        )
          return { error: "invalid_linking_user" };

        const accountId = z.object({ oid: z.string().min(1) }).parse(source.oauth.profile).oid;

        const saved = await environment.DB.prepare(
          "SELECT accountId FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, "microsoft")
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
        trustedProviders: ["microsoft"],
      },
    },
    advanced: { cookiePrefix: "account_microsoft" },
    socialProviders: {
      microsoft: {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        // Dataverse is for work and school accounts.
        tenantId: "organizations",
        // Better Auth would add Microsoft Graph's User.Read, a second resource.
        disableDefaultScope: true,
        scope: [...scopes],
        // People often have several Microsoft accounts; they choose the one to connect.
        prompt: "select_account",
        disableSignUp: true,
        disableProfilePhoto: true,
        mapProfileToUser: (profile) => ({ providerEmail: profile.email }),
      },
    },
    plugins: [
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
