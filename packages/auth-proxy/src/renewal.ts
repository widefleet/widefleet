import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { getAccountCookie, setAccountCookie, setSessionCookie } from "better-auth/cookies";
import {
  authorization,
  renewCompanyAuthorization,
  type CompanyAuthorization,
} from "./company-authorization.ts";

// Renews an app session whose company authorization expired. The account cookie
// holds the provider credential; the session holds the verified authorization.
export const sessionRenewal = (verified: () => CompanyAuthorization | undefined) =>
  ({
    id: "app-session-renewal",
    endpoints: {
      renewAppSession: createAuthEndpoint("/renew-app-session", { method: "POST" }, async (ctx) => {
        const current = await getSessionFromCtx(ctx);
        const previous = authorization.safeParse(current?.user["appAuthorization"]);

        if (!current || !previous.success) throw new APIError("UNAUTHORIZED");
        const account = await getAccountCookie(ctx);

        // Better Auth's DB-less account-cookie selection does not bind the account to
        // the session user. Both cookies must describe the same original login.
        if (
          !account ||
          account.userId !== current.user.id ||
          account.providerId !== "company" ||
          account.accountId !== previous.data.identity.id
        )
          throw new APIError("UNAUTHORIZED");

        const provider = ctx.context.socialProviders.find(
          (candidate) => candidate.id === "company",
        );

        if (!provider) throw new APIError("SERVICE_UNAVAILABLE");

        const renewal = await renewCompanyAuthorization(
          provider,
          verified,
          previous.data,
          {
            refreshToken: account.refreshToken ?? undefined,
            refreshExpiresAt: account.refreshTokenExpiresAt
              ? new Date(account.refreshTokenExpiresAt).getTime()
              : undefined,
            // Better Auth stores account scopes as a comma-separated string.
            scopes: account.scope?.split(",").filter(Boolean),
          },
          ctx,
        );

        // Persist rotation even when the identity could not be verified. This does
        // not extend authorization: that still requires a verified new identity.
        if (renewal.status !== "sign-in-required" && renewal.credential)
          await setAccountCookie(ctx, {
            ...account,
            scope: renewal.credential.scopes?.join(",") ?? account.scope,
            accessToken: null,
            idToken: null,
            refreshToken: renewal.credential.refreshToken,
            refreshTokenExpiresAt:
              renewal.credential.refreshExpiresAt === undefined
                ? account.refreshTokenExpiresAt
                : new Date(renewal.credential.refreshExpiresAt),
          });

        if (renewal.status === "sign-in-required") throw new APIError("UNAUTHORIZED");

        if (renewal.status === "denied") throw new APIError("FORBIDDEN");

        if (renewal.status === "unavailable")
          throw new APIError(
            "SERVICE_UNAVAILABLE",
            undefined,
            renewal.retryAfter ? { "Retry-After": renewal.retryAfter } : undefined,
          );

        const now = new Date();

        const user = {
          ...current.user,
          name: renewal.authorization.identity.name,
          email: renewal.authorization.identity.email,
          appAuthorization: renewal.authorization,
        };

        await setSessionCookie(ctx, {
          session: {
            ...current.session,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + ctx.context.sessionConfig.expiresIn * 1000),
          },
          user,
        });

        return ctx.json(renewal.authorization.identity);
      }),
    },
  }) satisfies BetterAuthPlugin;
