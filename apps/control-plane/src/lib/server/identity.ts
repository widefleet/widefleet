import { Result, TaggedError, type InferOk } from "better-result";
import { and, eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { apiResource } from "./auth-options.ts";
import { member, user, organization, session as sessions } from "./auth-schema.ts";
import {
  installationOrganizationId,
  organizationRole,
  organizationRoles,
} from "../organization.ts";
import type { Authentication } from "./auth.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { FleetAccess } from "./application-context.ts";
import { defaultFleet } from "./fleets.ts";
import { fleets } from "./schema.ts";
import { DatabaseUnavailable } from "./errors.ts";

export class AuthenticationFailed extends TaggedError("AuthenticationFailed")<{
  code: "UNAUTHORIZED" | "FORBIDDEN" | "ORGANIZATION_REQUIRED" | "CONFLICT";
  message: string;
}> {}

const tokenClaims = z.object({ sub: z.string().min(1), scope: z.string() });

export const createIdentityService = (
  auth: Authentication,
  database: Database,
  configuration: Configuration,
  access: FleetAccess = {
    filterFleets: async () => [(await defaultFleet(database)).id],
    defaultOrganizationId: installationOrganizationId,
  },
) => {
  const memberships = (userId: string) =>
    Result.tryPromise({
      try: async () => {
        const records = await database
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            role: member.role,
            organizationId: organization.id,
            organizationName: organization.name,
            organizationSlug: organization.slug,
            fleetId: fleets.id,
          })
          .from(user)
          .innerJoin(member, eq(member.userId, user.id))
          .innerJoin(organization, eq(organization.id, member.organizationId))
          .innerJoin(fleets, eq(fleets.organizationId, organization.id))
          .where(eq(user.id, userId))
          .orderBy(organization.name, organization.id, fleets.id);

        const admitted = new Set(
          await access.filterFleets(
            records.map((record) => ({
              id: record.fleetId,
              organizationId: record.organizationId,
            })),
          ),
        );

        // An extension can narrow membership access, never grant membership itself.
        const eligible = records.flatMap((record) => {
          const role = organizationRole.safeParse(record.role);

          return admitted.has(record.fleetId) && role.success
            ? [{ ...record, role: role.data }]
            : [];
        });

        // Multiple execution fleets need an explicit selection contract. Discovery
        // and automatic selection must agree on which organizations are available.
        return eligible.filter(
          (record) =>
            eligible.filter((other) => other.organizationId === record.organizationId).length === 1,
        );
      },
      catch: (cause) =>
        new DatabaseUnavailable({ message: "Could not read organization access", cause }),
    });

  const resolveUser = (userId: string, organizationId: string | null) =>
    Result.gen(async function* () {
      const records = yield* Result.await(memberships(userId));

      const matching =
        organizationId === null
          ? records
          : records.filter((record) => record.organizationId === organizationId);

      if (organizationId === null && matching.length !== 1)
        return yield* new AuthenticationFailed({
          code: "ORGANIZATION_REQUIRED",
          message:
            "Select an organization. API clients must send X-Widefleet-Organization; CLI users can pass --organization ID.",
        });

      const record = matching[0];

      if (!record || matching.length !== 1)
        return yield* new AuthenticationFailed({
          code: "FORBIDDEN",
          message: "This organization is unavailable or you are no longer a member",
        });

      const admin = organizationRoles[record.role].authorize({ agent: ["manage"] }).success;

      return Result.ok({
        id: record.id,
        name: record.name,
        email: record.email,
        role: record.role,
        admin: record.organizationId === installationOrganizationId && admin,
        application: {
          fleetId: record.fleetId,
          organizationId: record.organizationId,
          admin,
        },
        creator: organizationRoles[record.role].authorize({ app: ["create"] }).success,
      });
    });

  const verify = (request: Request, scope: "platform:read" | "platform:write" | "network:manage") =>
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

        const [current] = yield* Result.await(
          Result.tryPromise({
            try: () => database.select({ id: user.id }).from(user).where(eq(user.id, verified.sub)),
            catch: (cause) =>
              new DatabaseUnavailable({ message: "Could not verify the current user", cause }),
          }),
        );

        if (!current)
          return yield* new AuthenticationFailed({
            code: "UNAUTHORIZED",
            message: "The user no longer exists",
          });

        return Result.ok({ userId: current.id, sessionId: null, activeOrganizationId: null });
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

      return Result.ok({
        userId: session.user.id,
        sessionId: session.session.id,
        activeOrganizationId: session.session.activeOrganizationId ?? null,
      });
    });

  const authenticate = (
    request: Request,
    scope: "platform:read" | "platform:write" | "network:manage",
    expectedOrganizationId?: string,
  ) =>
    Result.gen(async function* () {
      const verified = yield* Result.await(verify(request, scope));

      const organizationId =
        request.headers.get("x-widefleet-organization") ??
        verified.activeOrganizationId ??
        access.defaultOrganizationId ??
        null;

      const principal = yield* Result.await(resolveUser(verified.userId, organizationId));

      // A rendered browser form carries its displayed organization. Never reinterpret
      // that form using a selection changed by another tab in the same session.
      if (
        expectedOrganizationId !== undefined &&
        expectedOrganizationId !== principal.application.organizationId
      )
        return yield* new AuthenticationFailed({
          code: "CONFLICT",
          message: "Your organization selection changed. Reload this page before making changes.",
        });

      return Result.ok(principal);
    });

  const organizations = (request: Request) =>
    Result.gen(async function* () {
      const verified = yield* Result.await(verify(request, "platform:read"));
      const records = yield* Result.await(memberships(verified.userId));

      return Result.ok(
        records.map((record) => ({
          id: record.organizationId,
          name: record.organizationName,
          slug: record.organizationSlug,
          role: record.role,
        })),
      );
    });

  const selectOrganization = (request: Request, organizationId: string) =>
    Result.gen(async function* () {
      const verified = yield* Result.await(verify(request, "platform:write"));
      const principal = yield* Result.await(resolveUser(verified.userId, organizationId));

      if (verified.sessionId) {
        const sessionId = verified.sessionId;

        const updated = yield* Result.await(
          Result.tryPromise({
            try: () =>
              database
                .update(sessions)
                .set({ activeOrganizationId: organizationId })
                .where(and(eq(sessions.id, sessionId), eq(sessions.userId, verified.userId)))
                .returning({ id: sessions.id }),
            catch: (cause) =>
              new DatabaseUnavailable({ message: "Could not save organization selection", cause }),
          }),
        );

        if (!updated.length)
          return yield* new AuthenticationFailed({
            code: "UNAUTHORIZED",
            message: "Sign in to continue",
          });
      }

      return Result.ok(principal);
    });

  return { authenticate, organizations, selectOrganization };
};

export type IdentityService = ReturnType<typeof createIdentityService>;

export type Principal = InferOk<Awaited<ReturnType<IdentityService["authenticate"]>>>;
