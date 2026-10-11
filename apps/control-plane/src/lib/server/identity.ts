import { Result, TaggedError, type InferOk } from "better-result";
import { and, eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { apiResource } from "./auth-options.ts";
import { account, member, user } from "./auth-schema.ts";
import { readCompanyClaims } from "./company-claims.ts";
import { readCompanyGroups } from "./company-groups.ts";
import { companyAccountProvider } from "./company-identity.ts";
import {
  installationOrganizationId,
  organizationRole,
  organizationRoles,
} from "../organization.ts";
import type { Authentication } from "./auth.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import { DatabaseUnavailable } from "./errors.ts";

export class AuthenticationFailed extends TaggedError("AuthenticationFailed")<{
  code: "UNAUTHORIZED" | "FORBIDDEN";
  message: string;
}> {}

const tokenClaims = z.object({ sub: z.string().min(1), scope: z.string() });

export const createIdentityService = (
  auth: Authentication,
  database: Database,
  configuration: Configuration,
  request: typeof fetch = fetch,
) => {
  const memberships = new Map<string, { expiresAt: number; groups: Promise<string[]> }>();

  const resolveUser = (userId: string, recovery = false) =>
    Result.gen(async function* () {
      const [record] = yield* Result.await(
        Result.tryPromise({
          try: () =>
            database
              .select({
                id: user.id,
                name: user.name,
                email: user.email,
                role: member.role,
              })
              .from(user)
              .innerJoin(
                member,
                and(
                  eq(member.userId, user.id),
                  eq(member.organizationId, installationOrganizationId),
                ),
              )
              .where(eq(user.id, userId)),
          catch: (cause) =>
            new DatabaseUnavailable({ message: "Could not read current user permissions", cause }),
        }),
      );

      if (!record) {
        return yield* new AuthenticationFailed({
          code: "UNAUTHORIZED",
          message: "An active organization membership is required",
        });
      }

      const role = organizationRole.safeParse(record.role);

      if (!role.success)
        return yield* new AuthenticationFailed({
          code: "FORBIDDEN",
          message: "An active organization membership is required",
        });

      const company = yield* Result.await(
        Result.tryPromise({
          try: async () => {
            // Recovery uses the local session and current installation role without an IdP dependency.
            if (!configuration.IDENTITY || recovery) return undefined;

            const [linked] = await database
              .select()
              .from(account)
              .where(
                and(
                  eq(account.userId, record.id),
                  eq(account.providerId, companyAccountProvider(configuration.IDENTITY)),
                ),
              );

            const claims = linked
              ? readCompanyClaims(configuration.IDENTITY.provider, linked)
              : undefined;

            if (!claims || !linked || !claims.overage || claims.groupsExpired) return claims;

            for (const [key, cached] of memberships)
              if (cached.expiresAt <= Date.now()) memberships.delete(key);

            const key = JSON.stringify([linked.id, linked.idToken]);
            let cached = memberships.get(key);

            if (!cached) {
              if (memberships.size >= 100) {
                const oldest = memberships.keys().next().value;

                if (oldest) memberships.delete(oldest);
              }

              cached = {
                expiresAt: claims.expiresAt,
                groups: (async () => {
                  const token = await auth.api.getAccessToken({
                    body: { accountId: linked.id, userId: record.id },
                  });

                  return readCompanyGroups(
                    z.string().min(1).parse(token.accessToken),
                    claims.subject,
                    request,
                  );
                })(),
              };
              // Share in-flight work as well as completed results for this verified token.
              memberships.set(key, cached);
            }

            let current;

            try {
              current = await cached.groups;
            } catch (cause) {
              if (memberships.get(key) === cached) memberships.delete(key);
              throw cause;
            }

            if (claims.expiresAt <= Date.now())
              return { ...claims, groups: [], groupsExpired: true };

            return { ...claims, groups: current };
          },
          catch: (cause) =>
            new DatabaseUnavailable({ message: "Could not read company identity", cause }),
        }),
      );

      return Result.ok({
        id: record.id,
        name: record.name,
        email: record.email,
        role: role.data,
        admin: organizationRoles[role.data].authorize({ agent: ["manage"] }).success,
        creator: organizationRoles[role.data].authorize({ app: ["create"] }).success,
        company,
      });
    });

  const authenticate = (
    request: Request,
    scope: "platform:read" | "platform:write" | "network:manage",
  ) =>
    Result.gen(async function* () {
      const authorization = request.headers.get("authorization");

      if (authorization !== null) {
        if (!authorization.startsWith("Bearer ")) {
          return yield* new AuthenticationFailed({
            code: "UNAUTHORIZED",
            message: "A Bearer access token is required",
          });
        }

        const verified = yield* Result.await(
          Result.tryPromise({
            try: async () => {
              const keys = await auth.api.getJwks();

              const { payload } = await jwtVerify(authorization.slice(7), createLocalJWKSet(keys), {
                issuer: `${configuration.PLATFORM_URL}/api/auth`,
                audience: apiResource(configuration),
                algorithms: ["EdDSA"],
                requiredClaims: ["exp", "iat", "sub", "scope"],
              });

              return tokenClaims.parse(payload);
            },
            catch: () =>
              new AuthenticationFailed({
                code: "UNAUTHORIZED",
                message: "Invalid or expired access token",
              }),
          }),
        );

        if (!verified.scope.split(" ").includes(scope)) {
          return yield* new AuthenticationFailed({
            code: "FORBIDDEN",
            message: "The access token lacks the required scope",
          });
        }

        return resolveUser(verified.sub);
      }

      if (
        scope !== "platform:read" &&
        request.headers.get("origin") !== configuration.PLATFORM_URL
      ) {
        return yield* new AuthenticationFailed({
          code: "FORBIDDEN",
          message: "A same-origin request is required",
        });
      }

      const session = yield* Result.await(
        Result.tryPromise({
          try: () => auth.api.getSession({ headers: request.headers }),
          catch: (cause) =>
            new DatabaseUnavailable({ message: "Could not verify the session", cause }),
        }),
      );

      if (!session) {
        return yield* new AuthenticationFailed({
          code: "UNAUTHORIZED",
          message: "Sign in to continue",
        });
      }

      return resolveUser(session.user.id, session.session.recovery);
    });

  return { authenticate };
};

export type IdentityService = ReturnType<typeof createIdentityService>;

export type Principal = InferOk<Awaited<ReturnType<IdentityService["authenticate"]>>>;
