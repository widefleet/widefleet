import { createHash } from "node:crypto";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { JSONWebKeySet } from "jose";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { identityUrl } from "@platform/contracts";
import { verifyAccessToken } from "./access-token.ts";
import { organizationSettings } from "./schema.ts";
import { invitation, ssoProvider, user } from "./auth-schema.ts";
import type { OrganizationAccess } from "./application-context.ts";
import type { Configuration } from "./config.ts";
import type { DatabaseExecutor } from "./database.ts";
import { installationOrganizationId } from "../organization.ts";
import { oidcConfiguration, prepareCompanyOidc } from "./sso-origins.ts";
import { decryptSecret } from "./secret-encryption.ts";

export const managedPluginPaths = [
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/update-member-role",
  "/organization/remove-member",
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
];

export const pluginAuthentication = (
  database: DatabaseExecutor,
  configuration: Configuration,
  encryptionKey: string,
  keys: () => Promise<JSONWebKeySet>,
  access: OrganizationAccess = { filterOrganizations: async () => [installationOrganizationId] },
) =>
  createAuthMiddleware(async (context) => {
    if (!managedPluginPaths.includes(context.path)) return undefined;
    const headers = context.headers;

    if (!headers) throw new APIError("UNAUTHORIZED");
    const authorization = headers.get("authorization");
    let current = await getSessionFromCtx(context);

    if (authorization !== null) {
      if (!authorization.startsWith("Bearer ")) throw new APIError("UNAUTHORIZED");
      const token = authorization.slice(7);

      const credential = await verifyAccessToken(token, await keys(), configuration).catch(() => {
        throw new APIError("UNAUTHORIZED", { message: "Invalid or expired access token" });
      });

      if (!credential.scope.split(" ").includes("platform:write"))
        throw new APIError("FORBIDDEN", { message: "The access token lacks the required scope" });
      const [subject] = await database.select().from(user).where(eq(user.id, credential.sub));

      if (!subject) throw new APIError("UNAUTHORIZED");
      // Authenticate this invocation with the actual OAuth credential. This context
      // is never persisted or issued as a browser session; its deadline is the JWT's.
      // Only the management operations above accept it, never session/account APIs.
      current = {
        user: subject,
        session: {
          id: `oauth:${credential.jti ?? createHash("sha256").update(token).digest("hex")}`,
          token,
          userId: subject.id,
          createdAt: new Date(credential.iat * 1000),
          updatedAt: new Date(credential.iat * 1000),
          expiresAt: new Date(credential.exp * 1000),
          identityOrganizationId: credential.authority.organizationId,
          activeOrganizationId: headers.get("x-widefleet-organization"),
        },
      };
    }

    if (!current) throw new APIError("UNAUTHORIZED");

    const input = z
      .looseObject({
        organizationId: z.string().optional(),
        providerId: z.string().optional(),
        invitationId: z.string().optional(),
        issuer: identityUrl.optional(),
        oidcConfig: oidcConfiguration.optional(),
      })
      .parse(context.body);

    let organizationId = input.organizationId;

    const [provider] =
      input.providerId && context.path !== "/sso/register"
        ? await database
            .select()
            .from(ssoProvider)
            .where(eq(ssoProvider.providerId, input.providerId))
        : [];

    if (input.providerId && context.path !== "/sso/register") {
      if (organizationId && organizationId !== provider?.organizationId)
        throw new APIError("FORBIDDEN");
      organizationId = provider?.organizationId;
    }

    if (input.invitationId) {
      const [pending] = await database
        .select({ organizationId: invitation.organizationId })
        .from(invitation)
        .where(eq(invitation.id, input.invitationId));

      if (organizationId && organizationId !== pending?.organizationId)
        throw new APIError("FORBIDDEN");
      organizationId = pending?.organizationId;
    }

    if (
      !organizationId ||
      !(await access.filterOrganizations([{ id: organizationId }])).includes(organizationId)
    )
      throw new APIError("FORBIDDEN", { message: "This organization is unavailable" });

    const authority = z
      .string()
      .nullable()
      .parse(current.session["identityOrganizationId"] ?? null);

    if (authority !== null && authority !== organizationId)
      throw new APIError("FORBIDDEN", {
        message: "This company sign-in cannot access another organization",
      });
    const selection = headers.get("x-widefleet-organization");

    if (
      selection !== null &&
      selection !== organizationId &&
      !["/organization/accept-invitation", "/organization/reject-invitation"].includes(context.path)
    )
      throw new APIError("FORBIDDEN", {
        message: "This operation belongs to another organization",
      });

    const [company] = await database
      .select({ verified: ssoProvider.domainVerified })
      .from(ssoProvider)
      .innerJoin(
        organizationSettings,
        eq(organizationSettings.organizationId, ssoProvider.organizationId),
      )
      .where(
        and(
          eq(ssoProvider.organizationId, organizationId),
          eq(organizationSettings.ssoRequired, true),
        ),
      );

    if (company?.verified && authority !== organizationId && current.session["recovery"] !== true)
      throw new APIError("FORBIDDEN", { message: "Sign in with this organization's company SSO" });

    context.context.session = current;

    // Prepare endpoints once and let the native plugin persist them. Existing
    // endpoints survive ordinary updates; changing issuer requires fresh discovery.
    const issuer = input.issuer ?? provider?.issuer;

    if (
      issuer &&
      (input.oidcConfig || (input.issuer && provider?.oidcConfig)) &&
      ["/sso/register", "/sso/update-provider"].includes(context.path)
    ) {
      const saved =
        provider?.oidcConfig && issuer === provider.issuer
          ? oidcConfiguration.parse(
              JSON.parse(await decryptSecret(encryptionKey, provider.oidcConfig)),
            )
          : {};

      const prepared = await prepareCompanyOidc(issuer, { ...saved, ...input.oidcConfig });
      context.context.trustedOrigins = [...context.context.trustedOrigins, ...prepared.origins];

      if (context.path === "/sso/register")
        return {
          context: {
            body: { ...input, oidcConfig: { ...prepared.configuration, skipDiscovery: true } },
          },
        };

      // Leave omitted credentials and claims for the plugin's transactional merge.
      if (prepared.discovered)
        return {
          context: {
            body: {
              ...input,
              oidcConfig: {
                ...input.oidcConfig,
                ...oidcConfiguration.strip().parse(prepared.configuration),
              },
            },
          },
        };
    }

    return undefined;
  });
