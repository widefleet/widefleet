import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { cliApprovalCode, cliCallbackUrl } from "./cli-login.ts";
import { cliClientId, cliScopes } from "./auth-options.ts";
import { oauthClient } from "./auth-schema.ts";
import type { Configuration } from "./config.ts";
import type { DatabaseExecutor } from "./database.ts";

export const cliConsent = async (
  query: URLSearchParams,
  configuration: Configuration,
  database: DatabaseExecutor,
) => {
  if (!query.has("client_id")) return null;
  const oauthQuery = query.toString();
  const challenge = query.get("code_challenge") ?? "";
  const scopes = (query.get("scope") ?? "").split(" ");
  const resource = `${configuration.PLATFORM_URL}/api/v1`;

  if (
    !configuration.BETTER_AUTH_SECRET ||
    !(await verifyOAuthQueryParams(oauthQuery, configuration.BETTER_AUTH_SECRET)) ||
    query.get("client_id") !== cliClientId ||
    query.get("redirect_uri") !== cliCallbackUrl ||
    query.get("response_type") !== "code" ||
    query.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    !scopes.every((scope) => cliScopes.includes(scope)) ||
    query.getAll("resource").length !== 1 ||
    query.get("resource") !== resource
  )
    throw new APIError("BAD_REQUEST", { message: "Invalid or expired CLI authorization request" });

  const [client] = await database
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.clientId, cliClientId));

  if (!client || client.disabled || !client.redirectUris.includes(cliCallbackUrl))
    throw new APIError("FORBIDDEN", { message: "CLI authorization is unavailable" });

  return { oauthQuery, code: cliApprovalCode(challenge), scope: scopes.join(" "), resource };
};
