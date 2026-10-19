import { Result, TaggedError, type InferOk } from "better-result";
import { and, eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { apiResource } from "./auth-options.ts";
import { member, user } from "./auth-schema.ts";
import {
  installationOrganizationId,
  organizationRole,
  organizationRoles,
} from "../organization.ts";
import type { Authentication } from "./auth.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { FleetSelector } from "./application-context.ts";
import { defaultFleet } from "./fleets.ts";
import { fleets } from "./schema.ts";
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
  selectFleet: FleetSelector = async () => (await defaultFleet(database)).id,
) => {
  const resolveUser = (userId: string, request: Request, activeOrganizationId: string | null) =>
    Result.gen(async function* () {
      const fleetId = yield* Result.await(
        Result.tryPromise({
          try: () => selectFleet({ userId, request, activeOrganizationId }),
          catch: (cause) =>
            cause instanceof AuthenticationFailed
              ? cause
              : new DatabaseUnavailable({ message: "Could not resolve application access", cause }),
        }),
      );

      const [record] = yield* Result.await(
        Result.tryPromise({
          try: () =>
            database
              .select({
                id: user.id,
                name: user.name,
                email: user.email,
                role: member.role,
                organizationId: member.organizationId,
              })
              .from(user)
              .innerJoin(fleets, eq(fleets.id, fleetId))
              .innerJoin(
                member,
                and(eq(member.userId, user.id), eq(member.organizationId, fleets.organizationId)),
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

      return Result.ok({
        id: record.id,
        name: record.name,
        email: record.email,
        role: role.data,
        // Installation administration never follows an unrelated organization role.
        admin:
          record.organizationId === installationOrganizationId &&
          organizationRoles[role.data].authorize({ agent: ["manage"] }).success,
        application: {
          fleetId,
          organizationId: record.organizationId,
          admin: organizationRoles[role.data].authorize({ agent: ["manage"] }).success,
        },
        creator: organizationRoles[role.data].authorize({ app: ["create"] }).success,
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

        return resolveUser(verified.sub, request, null);
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

      return resolveUser(session.user.id, request, session.session.activeOrganizationId ?? null);
    });

  return { authenticate };
};

export type IdentityService = ReturnType<typeof createIdentityService>;

export type Principal = InferOk<Awaited<ReturnType<IdentityService["authenticate"]>>>;
