import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { z } from "zod";
import { appOrigins, basePath, caller, callerKey, type Environment } from "./context.ts";

const profile = z.object({
  id: z.union([z.string(), z.number()]),
  login: z.string(),
  name: z.string().nullish(),
  email: z.email().nullish(),
});

export const userId = async (database: D1Database, key: string) =>
  database
    .prepare('SELECT id FROM "user" WHERE "widefleetSubject" = ?')
    .bind(key)
    .first<string>("id");

// The caller comes from trusted entrypoint props, never from request headers or a form.
// This plugin creates a short-lived Better Auth session solely for explicit account linking.
const connectorSession = (environment: Environment, identity: z.infer<typeof caller>) => ({
  id: "widefleet-connector-session",
  endpoints: {
    establishConnectorSession: createAuthEndpoint(
      "/widefleet-session",
      { method: "POST" },
      async (context) => {
        const key = await callerKey(identity);
        const id = await userId(environment.DB, key);

        const user = id
          ? await context.context.internalAdapter.findUserById(id)
          : await context.context.internalAdapter.createUser(
              {
                name: identity.name,
                // Better Auth requires an email. This non-deliverable value is derived from
                // the verified principal, and is never used to match a GitHub email.
                email: `${key}@connector.invalid`,
                emailVerified: false,
                widefleetSubject: key,
              },
              { method: "widefleet-connector" },
            );

        if (!user) throw context.error("INTERNAL_SERVER_ERROR");
        const session = await context.context.internalAdapter.createSession(user.id);

        if (!session) throw context.error("INTERNAL_SERVER_ERROR");
        await setSessionCookie(context, { user, session });

        return context.json({ established: true });
      },
    ),
  },
});

export const authentication = async (environment: Environment, identity: z.infer<typeof caller>) =>
  betterAuth({
    database: environment.DB,
    secret: await environment.WIDEFLEET_SECRETS.get("AUTH_SECRET"),
    baseURL: environment.CONNECTOR_ORIGIN,
    basePath: `${basePath(environment)}/auth`,
    trustedOrigins: appOrigins(environment),
    session: { expiresIn: 900, disableSessionRefresh: true },
    user: {
      additionalFields: {
        widefleetSubject: { type: "string", required: false, input: false, unique: true },
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeAccountCookie: false,
      storeStateStrategy: "database",
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        // Linking is explicit and bound to the verified caller, not to the provider email.
        trustedProviders: ["github"],
        allowDifferentEmails: true,
        allowUnlinkingAll: true,
      },
    },
    advanced: {
      cookiePrefix: "connector_github",
      defaultCookieAttributes: { path: basePath(environment) },
    },
    plugins: [
      connectorSession(environment, identity),
      genericOAuth({
        config: [
          {
            providerId: "github",
            authorizationUrl: `${environment.PROVIDER_ORIGIN}/login/oauth/authorize`,
            tokenUrl: `${environment.PROVIDER_ORIGIN}/login/oauth/access_token`,
            clientId: environment.GITHUB_CLIENT_ID,
            clientSecret: await environment.WIDEFLEET_SECRETS.get("GITHUB_CLIENT_SECRET"),
            scopes: environment.GITHUB_SCOPES.split(" ").filter(Boolean),
            pkce: true,
            disableSignUp: true,
            getUserInfo: async (tokens) => {
              const response = await fetch(`${environment.PROVIDER_API_ORIGIN}/user`, {
                headers: {
                  authorization: `Bearer ${tokens.accessToken}`,
                  accept: "application/json",
                },
              });

              if (!response.ok) throw new Error("GitHub profile request failed");
              const value = profile.parse(await response.json());

              return {
                id: String(value.id),
                name: value.name ?? value.login,
                email: value.email ?? `${value.id}@github.connector.invalid`,
                emailVerified: false,
              };
            },
          },
        ],
      }),
    ],
  });

export const accessToken = async (
  environment: Environment,
  identity: z.infer<typeof caller>,
  selection: { userId: string; accountId: string },
) => {
  const auth = await authentication(environment, identity);
  const provider = (await auth.$context).socialProviders.find((entry) => entry.id === "github");
  const refresh = provider?.refreshAccessToken;

  if (!provider || !refresh) throw new Error("GitHub refresh provider is not configured");
  let invalidGrant = false;

  // Better Auth 1.7.12 replaces refresh failures with FAILED_TO_GET_ACCESS_TOKEN.
  // Capture only the provider's invalid_grant before that conversion; provider
  // configuration, network, storage and other errors must still fail the call.
  // This auth instance and its provider belong only to this invocation.
  provider.refreshAccessToken = async (...args) => {
    try {
      return await refresh(...args);
    } catch (error) {
      invalidGrant = z
        .object({ error: z.literal("invalid_grant"), status: z.literal(400) })
        .safeParse(error).success;
      throw error;
    }
  };

  try {
    return await auth.api.getAccessToken({ body: selection });
  } catch (error) {
    if (invalidGrant) return null;
    throw error;
  }
};
