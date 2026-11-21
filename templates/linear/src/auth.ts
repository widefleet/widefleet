import { managedOAuthPlugin, type OAuthCredentials } from "./oauth.ts";
import { z } from "zod";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { Caller, Environment } from "./context.ts";
import { ensureUser } from "./database.ts";
import { callTool, profile, rpcRequest, rpcResult, toolOutput } from "./linear.ts";

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
          source.oauth?.providerId !== "linear"
        )
          return { error: "invalid_linking_user" };

        const accountId = z.object({ id: z.string().min(1) }).parse(source.oauth.profile).id;

        const saved = await environment.DB.prepare(
          "SELECT accountId FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, "linear")
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
        trustedProviders: ["linear"],
      },
    },
    advanced: { cookiePrefix: "account_linear" },
    socialProviders: {
      linear: {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        // Better Auth adds the read scope; write enables every tool.
        scope: ["write"],
        disableSignUp: true,
        // Linear's MCP server accepts tokens from both registrations, so the
        // profile comes from the same origin the connector calls.
        getUserInfo: async (tokens) => {
          if (!tokens.accessToken) return null;

          const call = callTool({ name: "get_user", arguments: { query: "me" } });

          const result = toolOutput(
            await rpcResult(call, await fetch(rpcRequest(call, tokens.accessToken))),
          );

          if (result.status !== "connected") return null;
          const account = profile.parse(JSON.parse(result.text));

          return {
            user: {
              name: account.name,
              email: account.email,
              emailVerified: false,
              providerEmail: account.email,
            },
            data: {
              id: account.id,
              name: account.name,
              email: account.email,
              avatarUrl: account.avatarUrl ?? "",
              active: account.isActive ?? true,
              createdAt: account.createdAt ?? "",
              updatedAt: account.updatedAt ?? "",
            },
          };
        },
      },
    },
    plugins: [
      ...(credentials.managed && environment.WIDEFLEET_OAUTH
        ? [managedOAuthPlugin(environment.WIDEFLEET_OAUTH, "linear", ticket)]
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
