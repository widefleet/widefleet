import { sso } from "@better-auth/sso";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { installationOrganizationId } from "../organization.ts";
import type { OrganizationAccess } from "./application-context.ts";
import { invitation, member, ssoProvider, user } from "./auth-schema.ts";
import type { DatabaseExecutor } from "./database.ts";
import { decryptSecret, encryptSecret } from "./secret-encryption.ts";

export const companySsoOrigins = async (
  database: DatabaseExecutor,
  platformUrl: string,
  request?: Request,
) => {
  const origins = [platformUrl];

  if (!request) return origins;
  const path = new URL(request.url).pathname;

  if (!path.includes("/sso/") && !path.endsWith("/sign-in/sso")) return origins;

  // The IdP origins below authorize outbound OIDC requests, never an incoming
  // cross-origin management request carrying the user's cookies.
  if (request.headers.has("origin") && request.headers.get("origin") !== platformUrl)
    return origins;
  const callback = path.match(/\/sso\/callback\/([^/]+)$/)?.[1];

  const input =
    request.method === "POST" && !request.bodyUsed
      ? z.object({ providerId: z.string().optional() }).safeParse(
          await request
            .clone()
            .json()
            .catch(() => null),
        )
      : null;

  const providerId = callback ?? (input?.success ? input.data.providerId : undefined);

  if (!providerId) return origins;

  const [provider] = await database
    .select({ issuer: ssoProvider.issuer })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId));

  if (provider) {
    origins.push(new URL(provider.issuer).origin);

    if (new URL(provider.issuer).hostname === "login.microsoftonline.com")
      origins.push("https://graph.microsoft.com");
  }

  return origins;
};

export const companySsoPlugin = (
  database: DatabaseExecutor,
  encryptionKey: string,
  access: OrganizationAccess = { filterOrganizations: async () => [installationOrganizationId] },
) => {
  const plugin = sso({
    // The schema permits one provider per organization, regardless of its creator.
    providersLimit: Number.MAX_SAFE_INTEGER,
    domainVerification: { enabled: true },
    organizationProvisioning: { disabled: true },
    resolveUser: async (input) => {
      const [provider] = await database
        .select()
        .from(ssoProvider)
        .where(eq(ssoProvider.providerId, input.providerId));

      if (
        !provider?.domainVerified ||
        !(await access.filterOrganizations([{ id: provider.organizationId }])).includes(
          provider.organizationId,
        )
      )
        return { action: "reject", code: "ORGANIZATION_UNAVAILABLE" };

      // A verified company domain authorizes this provider's email identities,
      // not addresses outside that domain or membership in another organization.
      const email = input.providerUser.email.toLowerCase();

      if (email.split("@")[1] !== provider.domain)
        return { action: "reject", code: "COMPANY_EMAIL_REQUIRED" };

      if (provider.organizationId === installationOrganizationId) return { action: "continue" };

      const [membership] = await database
        .select({ id: member.id })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, provider.organizationId), eq(user.email, email)));

      const [pending] = await database
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, provider.organizationId),
            eq(invitation.email, email),
            eq(invitation.status, "pending"),
            gt(invitation.expiresAt, new Date()),
          ),
        );

      return membership || pending
        ? { action: "continue" }
        : { action: "reject", code: "INVITATION_REQUIRED" };
    },
  });

  // Better Auth's schema transforms cover every adapter read/write, including
  // the plugin's own transactions, without a second credential store.
  for (const field of ["oidcConfig", "samlConfig"]) {
    const definition = plugin.schema.ssoProvider.fields[field];

    if (!definition) throw new Error(`Missing SSO configuration field: ${field}`);
    definition.transform = {
      input: (value) =>
        value === null || value === undefined
          ? value
          : encryptSecret(encryptionKey, z.string().parse(value)),
      output: (value) =>
        value === null || value === undefined
          ? value
          : decryptSecret(encryptionKey, z.string().parse(value)),
    };
  }

  return plugin;
};
