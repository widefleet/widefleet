import { and, eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { base64url } from "jose";
import {
  companyOAuth,
  CompanySignInRequired,
  companyTokens,
} from "@platform/auth-proxy/company-oauth";
import { authConfiguration, sessionVersion } from "@platform/auth-proxy/configuration";
import { account } from "./auth-schema.ts";
import { appCallbackUrl } from "./app-sign-in.ts";
import { readAppLogin } from "./app-login-client.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { Principal } from "./identity.ts";
import type { createSettingsService } from "./settings.ts";

export const createAppUserIdentity =
  (
    database: Database,
    configuration: Configuration,
    settings: ReturnType<typeof createSettingsService>,
    encryptionKey: string,
  ) =>
  async (principal: Principal) => {
    const organizationId = principal.application.organizationId;
    const current = await settings.resolve(organizationId);

    if (current.errors.length)
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "Company sign-in configuration is unavailable",
      });

    const source =
      current.identity ??
      (await readAppLogin(database, configuration, encryptionKey, organizationId));

    if (!source)
      throw new APIError("SERVICE_UNAVAILABLE", { message: "App sign-in is not configured" });

    const sourceConfiguration = {
      organizationId,
      provider: source.provider,
      scopes: source.scopes,
      clientId: source.management.clientId,
      domain: configuration.APP_DOMAIN,
      redirectUrl: appCallbackUrl(configuration, organizationId),
    };

    const identityVersion = await sessionVersion(sourceConfiguration);

    if (!current.identity)
      return {
        identityVersion,
        identityExpiresAt: Date.now() + 300_000,
        identity: {
          issuer: `${configuration.PLATFORM_URL}/api/auth`,
          subject: principal.id,
          name: principal.name,
          groups: [],
        },
      };
    const providerId = current.sso?.providerId;

    if (!providerId) throw new APIError("SERVICE_UNAVAILABLE");

    const oauth = await companyOAuth(
      authConfiguration.parse({
        ...sourceConfiguration,
        clientSecret: source.management.clientSecret,
        // No cookies are issued here; this instance only verifies and refreshes the
        // existing native SSO account with the same mapper used by app sign-in.
        cookieSecret: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
      }),
    );

    // A rotating refresh token must have one owner even across overlapping status
    // requests. Commit rotated tokens before reporting a later directory failure.
    const outcome = await database.transaction(async (transaction) => {
      const accounts = await transaction
        .select()
        .from(account)
        .where(and(eq(account.userId, principal.id), eq(account.providerId, providerId)))
        .limit(2)
        .for("update");

      const saved = accounts.length === 1 ? accounts[0] : undefined;

      if (!saved?.idToken || !saved.accessToken)
        return { error: new CompanySignInRequired("Sign in with your company account again") };

      try {
        const verified = await oauth.account(
          companyTokens.parse({
            idToken: saved.idToken,
            accessToken: saved.accessToken,
            refreshToken: saved.refreshToken ?? undefined,
            accessTokenExpiresAt: saved.accessTokenExpiresAt ?? undefined,
            refreshTokenExpiresAt: saved.refreshTokenExpiresAt ?? undefined,
            scopes: saved.scope?.split(/[,\s]+/).filter(Boolean) ?? [],
          }),
          saved.accountId,
          async (tokens) => {
            await transaction
              .update(account)
              .set({
                accessToken: tokens.accessToken,
                idToken: tokens.idToken,
                refreshToken: tokens.refreshToken ?? null,
                accessTokenExpiresAt: tokens.accessTokenExpiresAt ?? null,
                refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? null,
                scope: tokens.scopes?.join(",") ?? saved.scope,
              })
              .where(eq(account.id, saved.id));
          },
        );

        return {
          identityExpiresAt: verified.authorization.expiresAt,
          identity: {
            issuer: oauth.issuer,
            subject: verified.authorization.identity.id,
            name: verified.authorization.identity.name,
            groups: verified.authorization.identity.groups,
          },
        };
      } catch (error) {
        return { error };
      }
    });

    if (outcome.identity)
      return {
        identityVersion,
        identityExpiresAt: outcome.identityExpiresAt,
        identity: outcome.identity,
      };

    if (outcome.error instanceof CompanySignInRequired)
      throw new APIError("UNAUTHORIZED", {
        message: "Sign in with your company account again to manage personal connections.",
      });
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: "Company sign-in could not be checked. Your connections have not changed.",
    });
  };
