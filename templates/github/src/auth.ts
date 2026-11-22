import { managedOAuthPlugin, type OAuthCredentials } from "./oauth.ts";
import { z } from "zod";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { Caller, Environment } from "./context.ts";
import { ensureUser } from "./database.ts";

/**
 * The scopes every offered method needs: repositories, issues and pull requests
 * (`repo`), workflow files in commits (`workflow`), Projects (`project`),
 * organizations and teams (`read:org`), and the user's status and follows (`user`).
 */
export const scopes = ["repo", "workflow", "project", "read:org", "user"] as const;

export const authentication = (
  environment: Environment,
  identity: Caller,
  id: string,
  credentials: OAuthCredentials,
  ticket?: string,
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
          source.oauth?.providerId !== "github"
        )
          return { error: "invalid_linking_user" };

        const accountId = String(z.object({ id: z.number().int() }).parse(source.oauth.profile).id);

        const saved = await environment.DB.prepare(
          "SELECT accountId FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, "github")
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
        trustedProviders: ["github"],
      },
    },
    advanced: { cookiePrefix: "account_github" },
    socialProviders: {
      github: {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        // Better Auth adds read:user and user:email.
        scope: [...scopes],
        disableSignUp: true,
        mapProfileToUser: (profile) => ({ providerEmail: profile.email }),
      },
    },
    plugins: [
      ...(credentials.managed && environment.WIDEFLEET_OAUTH
        ? [managedOAuthPlugin(environment.WIDEFLEET_OAUTH, "github", ticket)]
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
