import { companySsoAvailableSql } from "./sso-policy.ts";
import { verifyAccessToken } from "./access-token.ts";
import { Result, TaggedError, type InferOk } from "better-result";
import { eq, sql } from "drizzle-orm";
import { member, user, organization, ssoProvider } from "./auth-schema.ts";
import {
  installationOrganizationId,
  organizationRole,
  organizationRoles,
} from "../organization.ts";
import type { Authentication } from "./auth.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { OrganizationAccess } from "./application-context.ts";
import { organizationRuntimes, organizationSettings } from "./schema.ts";
import { DatabaseUnavailable } from "./errors.ts";

export class AuthenticationFailed extends TaggedError("AuthenticationFailed")<{
  code: "UNAUTHORIZED" | "FORBIDDEN" | "ORGANIZATION_REQUIRED" | "SSO_REQUIRED";
  message: string;
  organizationSlug?: string;
}> {}

export const createIdentityService = (
  auth: Authentication,
  database: Database,
  configuration: Configuration,
  access: OrganizationAccess = {
    filterOrganizations: async () => [installationOrganizationId],
    defaultOrganizationId: installationOrganizationId,
  },
  allowUser?: (userId: string) => Promise<boolean>,
) => {
  const memberships = (userId: string, identityOrganizationId: string | null) =>
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
            ssoRequired: sql<boolean>`coalesce(${companySsoAvailableSql(configuration)} AND ${organizationSettings.ssoRequired}, false)`,
          })
          .from(user)
          .innerJoin(member, eq(member.userId, user.id))
          .innerJoin(organization, eq(organization.id, member.organizationId))
          .innerJoin(organizationRuntimes, eq(organizationRuntimes.organizationId, organization.id))
          .leftJoin(ssoProvider, eq(ssoProvider.organizationId, organization.id))
          .leftJoin(organizationSettings, eq(organizationSettings.organizationId, organization.id))
          .where(eq(user.id, userId))
          .orderBy(organization.name, organization.id);

        const admitted = new Set(
          await access.filterOrganizations(
            records.map((record) => ({
              id: record.organizationId,
            })),
          ),
        );

        // An extension can narrow membership access, never grant membership itself.
        return records.flatMap((record) => {
          const role = organizationRole.safeParse(record.role);

          return admitted.has(record.organizationId) &&
            role.success &&
            (identityOrganizationId === null || identityOrganizationId === record.organizationId)
            ? [{ ...record, role: role.data }]
            : [];
        });
      },
      catch: (cause) =>
        new DatabaseUnavailable({ message: "Could not read organization access", cause }),
    });

  // A selection names an organization by ID, as API clients do, or by the slug in a page URL.
  // Without one, the extension's default or the member's only organization applies.
  const resolveMember = (
    userId: string,
    selection: { organizationId: string | null } | { organizationSlug: string },
    identityOrganizationId: string | null,
  ) =>
    Result.gen(async function* () {
      const records = yield* Result.await(memberships(userId, identityOrganizationId));
      const requested = "organizationId" in selection ? selection.organizationId : undefined;

      const selected =
        requested === undefined ? undefined : (requested ?? access.defaultOrganizationId ?? null);

      const matching =
        "organizationSlug" in selection
          ? records.filter((record) => record.organizationSlug === selection.organizationSlug)
          : selected === null
            ? records
            : records.filter((record) => record.organizationId === selected);

      if (selected === null && matching.length !== 1)
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

      if (record.ssoRequired && identityOrganizationId !== record.organizationId)
        return yield* new AuthenticationFailed({
          code: "SSO_REQUIRED",
          organizationSlug: record.organizationSlug,
          message: `Sign in with company SSO for ${record.organizationName}. Open /sign-in?organization=${encodeURIComponent(record.organizationSlug)} before authorizing the CLI.`,
        });

      const admin = organizationRoles[record.role].authorize({ agent: ["manage"] }).success;

      return Result.ok({
        principal: {
          id: record.id,
          name: record.name,
          email: record.email,
          role: record.role,
          admin: record.organizationId === installationOrganizationId && admin,
          application: {
            organizationId: record.organizationId,
            admin,
          },
          creator: organizationRoles[record.role].authorize({ app: ["create"] }).success,
        },
        organization: {
          id: record.organizationId,
          name: record.organizationName,
          slug: record.organizationSlug,
        },
      });
    });

  const resolveUser = (
    userId: string,
    organizationId: string | null,
    identityOrganizationId: string | null,
  ) =>
    resolveMember(userId, { organizationId }, identityOrganizationId).then((result) =>
      result.map(({ principal }) => principal),
    );

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
              return verifyAccessToken(
                authorization.slice(7),
                await auth.api.getJwks(),
                configuration,
              );
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

        if (!current || (allowUser && !(await allowUser(current.id))))
          return yield* new AuthenticationFailed({
            code: "UNAUTHORIZED",
            message: "The account is unavailable",
          });

        return Result.ok({
          userId: current.id,
          sessionId: null,
          identityOrganizationId: verified.authority.organizationId,
        });
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

      if (!session || (allowUser && !(await allowUser(session.user.id)))) {
        return yield* new AuthenticationFailed({
          code: "UNAUTHORIZED",
          message: "Sign in to continue",
        });
      }

      return Result.ok({
        identityOrganizationId: session.session.identityOrganizationId ?? null,
        userId: session.user.id,
        sessionId: session.session.id,
      });
    });

  // Requests name their organization with X-Widefleet-Organization. Without it, the
  // extension's default or the member's only organization applies.
  const authenticate = (
    request: Request,
    scope: "platform:read" | "platform:write" | "network:manage",
  ) =>
    Result.gen(async function* () {
      const verified = yield* Result.await(verify(request, scope));

      const principal = yield* Result.await(
        resolveUser(
          verified.userId,
          request.headers.get("x-widefleet-organization"),
          verified.identityOrganizationId,
        ),
      );

      return Result.ok(principal);
    });

  // Some resources name their organization themselves, such as an app's icon that a browser
  // loads without headers.
  const authenticateIn = (
    request: Request,
    scope: "platform:read" | "platform:write",
    organizationId: string,
  ) =>
    Result.gen(async function* () {
      const verified = yield* Result.await(verify(request, scope));

      return resolveUser(verified.userId, organizationId, verified.identityOrganizationId);
    });

  const listOrganizations = (userId: string, identityOrganizationId: string | null) =>
    Result.gen(async function* () {
      const records = yield* Result.await(memberships(userId, identityOrganizationId));

      return Result.ok(
        records.map((record) => ({
          id: record.organizationId,
          name: record.organizationName,
          slug: record.organizationSlug,
          role: record.role,
          ssoRequired:
            record.ssoRequired === true && identityOrganizationId !== record.organizationId,
        })),
      );
    });

  const organizations = (request: Request) =>
    Result.gen(async function* () {
      const verified = yield* Result.await(verify(request, "platform:read"));

      return Result.ok(
        yield* Result.await(listOrganizations(verified.userId, verified.identityOrganizationId)),
      );
    });

  return {
    authenticate,
    authenticateIn,
    organizations,
    authenticateUser: verify,
    principal: resolveUser,
    member: resolveMember,
    listOrganizations,
  };
};

export type IdentityService = ReturnType<typeof createIdentityService>;

export type Principal = InferOk<Awaited<ReturnType<IdentityService["authenticate"]>>>;

export type AuthenticatedUser = InferOk<Awaited<ReturnType<IdentityService["authenticateUser"]>>>;
