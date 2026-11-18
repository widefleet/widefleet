import { sso } from "@better-auth/sso";
import type { Configuration } from "./config.ts";
import { companySsoAvailable, operatorTrustedSso } from "./sso-policy.ts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { installationOrganizationId } from "../organization.ts";
import type { OrganizationAccess } from "./application-context.ts";
import { ssoProvider, user } from "./auth-schema.ts";
import type { DatabaseExecutor } from "./database.ts";
import { decryptSecret, encryptSecret } from "./secret-encryption.ts";
import { oidcConfiguration, prepareCompanyOidc } from "./sso-origins.ts";

export const companySsoOrigins = async (
  database: DatabaseExecutor,
  platformUrl: string,
  encryptionKey: string,
  request?: Request,
  policy?: Configuration,
) => {
  const origins = [platformUrl];

  if (!request) return origins;
  const path = new URL(request.url).pathname;

  const callback = path.match(/\/sso\/callback\/([^/]+)$/)?.[1];

  if (!callback && !path.endsWith("/sign-in/sso")) return origins;

  // The IdP origins below authorize outbound OIDC requests, never an incoming
  // cross-origin management request carrying the user's cookies.
  if (request.headers.has("origin") && request.headers.get("origin") !== platformUrl)
    return origins;

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
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId));

  if (!companySsoAvailable(policy, provider) || !provider?.oidcConfig) return origins;

  const configuration = oidcConfiguration.parse(
    JSON.parse(await decryptSecret(encryptionKey, provider.oidcConfig)),
  );

  const prepared = await prepareCompanyOidc(provider.issuer, configuration);

  origins.push(...prepared.origins);

  return origins;
};

export const companySsoPlugin = (
  database: DatabaseExecutor,
  encryptionKey: string,
  access: OrganizationAccess = { filterOrganizations: async () => [installationOrganizationId] },
  policy?: Configuration,
) => {
  const plugin = sso({
    // The schema permits one provider per organization, regardless of its creator.
    providersLimit: Number.MAX_SAFE_INTEGER,
    domainVerification: { enabled: !operatorTrustedSso(policy) },
    schema: {
      ssoProvider: {
        additionalFields: {
          appIdentityType: {
            type: "string",
            required: false,
            defaultValue: "oidc",
            validator: { input: z.enum(["oidc", "entra", "google"]) },
          },
        },
      },
    },
    resolveUser: async (input, context) => {
      const [provider] = await database
        .select()
        .from(ssoProvider)
        .where(eq(ssoProvider.providerId, input.providerId));

      if (
        !provider ||
        !companySsoAvailable(policy, provider) ||
        !(await access.filterOrganizations([{ id: provider.organizationId }])).includes(
          provider.organizationId,
        )
      )
        return { action: "reject", code: "ORGANIZATION_UNAVAILABLE" };

      if (
        operatorTrustedSso(policy, provider.organizationId) &&
        policy?.PLATFORM_SSO_ALLOW_EMAIL_ACCOUNT_LINKING
      ) {
        const bound = await context.database.findOne({
          model: "account",
          where: [
            { field: "providerId", value: input.providerId },
            { field: "accountId", value: input.accountKey.accountId },
          ],
        });

        if (!bound) {
          const existing = await context.database.findOne<{ id: string }>({
            model: "user",
            where: [{ field: "email", value: input.providerUser.email.toLowerCase() }],
          });

          if (existing) return { action: "link", userId: existing.id, profile: "preserve" };
        }
      }

      return { action: "continue" };
    },
    provisionUserOnEveryLogin: true,
    provisionUser: async ({ user: subject, userInfo, provider }) => {
      if (
        !provider.organizationId ||
        !operatorTrustedSso(policy, provider.organizationId) ||
        subject.emailVerified
      )
        return;

      // The operator vouches for this provider's email addresses. Confirm only
      // the matching local address so the user can accept its invitations.
      const email = z.string().parse(userInfo["email"]).toLowerCase();

      await database
        .update(user)
        .set({ emailVerified: true })
        .where(and(eq(user.id, subject.id), eq(user.email, email)));
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

  // Keep the DNS operations in the API even when the installation does not
  // require them. Shared authorization rejects them in operator-trusted mode.
  const verification = sso({ domainVerification: { enabled: true } });

  return {
    ...plugin,
    endpoints: {
      ...plugin.endpoints,
      requestDomainVerification: verification.endpoints.requestDomainVerification,
      verifyDomain: verification.endpoints.verifyDomain,
    },
  };
};
