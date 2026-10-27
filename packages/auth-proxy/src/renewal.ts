import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { getAccountCookie, setAccountCookie, setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { proxyIdentity } from "./identity.ts";

export const authorization = z.object({
  identity: proxyIdentity,
  subject: z.string().min(1),
  nonce: z.string().optional(),
  expiresAt: z.number().finite().positive(),
});

const tokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.date().optional(),
  refreshTokenExpiresAt: z.date().optional(),
  scopes: z.array(z.string()).optional(),
  tokenType: z.string().optional(),
});

// Only overlapping requests in this isolate share work. No session state is kept here.
const pending = new Map<string, Promise<z.infer<typeof tokens>>>();

const tokenFailure = z.object({ error: z.string().optional(), status: z.number().optional() });

const refreshTogether = async (key: string, refresh: () => Promise<z.infer<typeof tokens>>) => {
  const existing = pending.get(key);

  if (existing) return existing;

  const result = refresh();
  pending.set(key, result);

  try {
    return await result;
  } finally {
    pending.delete(key);
  }
};

export const sessionRenewal = (verified: () => z.infer<typeof authorization> | undefined) =>
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
          account.accountId !== previous.data.identity.id ||
          !account.refreshToken ||
          (account.refreshTokenExpiresAt &&
            new Date(account.refreshTokenExpiresAt).getTime() <= Date.now())
        )
          throw new APIError("UNAUTHORIZED");

        const provider = ctx.context.socialProviders.find(
          (candidate) => candidate.id === "company",
        );

        if (!provider?.refreshAccessToken) throw new APIError("SERVICE_UNAVAILABLE");
        const refresh = provider.refreshAccessToken;
        const credential = account.refreshToken;
        let renewed: z.infer<typeof tokens>;

        try {
          renewed = await refreshTogether(
            JSON.stringify([provider.issuer, account.accountId, credential]),
            async () => {
              try {
                return tokens.parse(await refresh(credential, ctx));
              } catch (cause) {
                const failure = tokenFailure.safeParse(cause);

                // Another isolate may still be committing the provider's rotation
                // replay response. Retry once before requiring a fresh login.
                if (!failure.success || failure.data.error !== "invalid_grant") throw cause;
                await new Promise((resolve) => setTimeout(resolve, 100));

                return tokens.parse(await refresh(credential, ctx));
              }
            },
          );
        } catch (cause) {
          const failure = tokenFailure.safeParse(cause);

          if (failure.success && failure.data.error === "invalid_grant")
            throw new APIError("UNAUTHORIZED");

          if (failure.success && failure.data.status === 403) throw new APIError("FORBIDDEN");
          throw new APIError("SERVICE_UNAVAILABLE");
        }

        // Refresh responses may omit the ID token. Never reuse the old ID token's
        // authorization claims as evidence of a newly verified identity.
        if (!renewed.idToken) throw new APIError("UNAUTHORIZED");
        const profile = await provider.getUserInfo(renewed);
        const next = authorization.safeParse(verified());

        if (
          !profile ||
          !next.success ||
          next.data.subject !== previous.data.subject ||
          next.data.identity.id !== previous.data.identity.id ||
          (next.data.nonce !== undefined && next.data.nonce !== previous.data.nonce) ||
          next.data.expiresAt <= Date.now()
        )
          throw new APIError("UNAUTHORIZED");

        await setAccountCookie(ctx, {
          ...account,
          accessToken: null,
          idToken: null,
          refreshToken: renewed.refreshToken ?? account.refreshToken,
          accessTokenExpiresAt: renewed.accessTokenExpiresAt,
          refreshTokenExpiresAt: renewed.refreshTokenExpiresAt ?? account.refreshTokenExpiresAt,
        });
        const now = new Date();

        const user = {
          ...current.user,
          name: next.data.identity.name,
          email: next.data.identity.email,
          appAuthorization: { ...next.data, nonce: previous.data.nonce },
        };

        await setSessionCookie(ctx, {
          session: {
            ...current.session,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + ctx.context.sessionConfig.expiresIn * 1000),
          },
          user,
        });

        return ctx.json(next.data.identity);
      }),
    },
  }) satisfies BetterAuthPlugin;
