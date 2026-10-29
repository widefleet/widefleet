import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { z } from "zod";
import { ensureUser } from "./database.ts";
import { google, providerId } from "./google.ts";
import type { Caller, Environment } from "./context.ts";

export const authPath = "/auth";

export const callbackPath = `${authPath}/callback/${providerId}`;

export const authentication = async (environment: Environment, identity: Caller, id: string) =>
  betterAuth({
    database: environment.DB,
    secret: await environment.WIDEFLEET_SECRETS.get("AUTH_SECRET"),
    baseURL: environment.WIDEFLEET_ORIGIN,
    basePath: authPath,
    trustedOrigins: [environment.WIDEFLEET_ORIGIN],
    session: { expiresIn: 600, disableSessionRefresh: true },
    user: {
      additionalFields: { providerEmail: { type: "string", required: false } },
      validateUserInfo: async ({ user, source }) => {
        if (
          source.action !== "link-account" ||
          user.id !== id ||
          source.oauth?.providerId !== providerId
        )
          return { error: "invalid_linking_user" };

        const profile = z.object({ id: z.string() }).parse(source.oauth.profile);

        const saved = await environment.DB.prepare(
          "SELECT accountId FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, providerId)
          .first<string>("accountId");

        if (saved && saved !== profile.id) return { error: "disconnect_before_switching_accounts" };

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
        trustedProviders: [providerId],
      },
    },
    advanced: { cookiePrefix: "gmail_connector" },
    plugins: [
      {
        id: "widefleet-caller",
        endpoints: {
          establishSession: createAuthEndpoint(
            "/widefleet-session",
            { method: "POST" },
            async (ctx) => {
              // Only called by connector code. Identity comes from ctx.props, never from HTTP input.
              // The synthetic email satisfies Better Auth's user schema; it is not used for linking.
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
      genericOAuth({
        config: [
          google(
            environment.GOOGLE_CLIENT_ID,
            await environment.WIDEFLEET_SECRETS.get("GOOGLE_CLIENT_SECRET"),
          ),
        ],
      }),
    ],
  });
