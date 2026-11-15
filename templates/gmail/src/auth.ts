import { managedOAuthPlugin, type OAuthCredentials } from "./oauth.ts";
import { z } from "zod";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { Caller, Environment } from "./context.ts";
import { ensureUser } from "./database.ts";

export const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";

export const authentication = (
  environment: Environment,
  identity: Caller,
  id: string,
  credentials: OAuthCredentials,
  ticket?: string,
) =>
  betterAuth({
    database: environment.DB,
    secret: credentials.authSecret,
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
          source.oauth?.providerId !== "google"
        )
          return { error: "invalid_linking_user" };

        const accountId = z.object({ sub: z.string().min(1) }).parse(source.oauth.profile).sub;

        const saved = await environment.DB.prepare(
          "SELECT accountId FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, "google")
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
        trustedProviders: ["google"],
      },
    },
    advanced: { cookiePrefix: "account_google" },
    socialProviders: {
      google: {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        scope: [gmailScope],
        accessType: "offline",
        prompt: "select_account consent",
        disableSignUp: true,
        mapProfileToUser: (profile) => ({ providerEmail: profile.email }),
      },
    },
    plugins: [
      ...(credentials.managed && environment.WIDEFLEET_OAUTH
        ? [managedOAuthPlugin(environment.WIDEFLEET_OAUTH, "google", ticket)]
        : []),
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
