import { discoverOIDCConfig } from "@better-auth/sso";
import { and, eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { identitySettingsInput } from "@platform/contracts";
import { z } from "zod";
import { createAuthentication } from "./auth.ts";
import { ssoProvider, session, oauthRefreshToken } from "./auth-schema.ts";
import { companyAccountProvider, providerIssuer } from "./company-identity.ts";
import type { Configuration } from "./config.ts";
import type { DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { createOrganizationSecrets } from "./organization-secrets.ts";
import { decryptSecret } from "./secret-encryption.ts";
import { organizationOperation, type OrganizationCredential } from "./organization-operations.ts";
import { authenticationReference } from "./authentication-context.ts";

export const readSsoProvider = async (database: DatabaseExecutor, organizationId: string) => {
  const [provider] = await database
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, organizationId));

  return provider ?? null;
};

export const prepareSsoConfiguration = async (identity: z.infer<typeof identitySettingsInput>) => {
  if (!identity.domain)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Enter the company email domain before configuring SSO",
    });
  const issuer = providerIssuer(identity.provider);
  const origin = new URL(issuer).origin;

  const discovered = await discoverOIDCConfig({
    issuer,
    isTrustedOrigin: (url) =>
      new URL(url).origin === origin ||
      (new URL(issuer).hostname === "login.microsoftonline.com" &&
        new URL(url).origin === "https://graph.microsoft.com"),
  });

  return {
    ...discovered,
    issuer,
    clientId: identity.management.clientId,
    pkce: true,
    scopes: ["openid", "profile", "email"],
    mapping:
      identity.provider.type === "oidc"
        ? { name: identity.provider.nameClaim, email: identity.provider.emailClaim }
        : { email: "email" },
  };
};

export const saveSsoProvider = async (
  database: DatabaseExecutor,
  configuration: Configuration,
  key: string,
  organizationId: string,
  identity: z.infer<typeof identitySettingsInput> | null,
  discovered: Awaited<ReturnType<typeof prepareSsoConfiguration>> | null,
  credential?: OrganizationCredential,
) => {
  const auth = createAuthentication(configuration, database, { encryptionKey: key });
  const { adapter } = await auth.$context;

  const existing =
    (
      await database
        .select()
        .from(ssoProvider)
        .where(eq(ssoProvider.organizationId, organizationId))
        .for("update")
    )[0] ?? null;

  const providerId = identity ? companyAccountProvider(identity, organizationId) : null;

  const previous = existing?.oidcConfig
    ? z
        .object({ clientId: z.string() })
        .parse(JSON.parse(await decryptSecret(key, existing.oidcConfig)))
    : null;

  const replace =
    existing !== null &&
    (!identity ||
      !discovered ||
      existing.providerId !== providerId ||
      existing.issuer !== discovered.issuer ||
      existing.domain !== identity.domain ||
      previous?.clientId !== identity.management.clientId);

  const clientSecret = identity
    ? await createOrganizationSecrets(database, key, organizationId).resolve(
        identity.management.secret,
      )
    : null;

  const oidcConfig = discovered && clientSecret ? { ...discovered, clientSecret } : null;

  if (credential) {
    // Native SSO CRUD owns provider validation, account cleanup and mutation
    // fencing. Only the privileged bootstrap path below has no user credential.
    const trustedOrigins = [configuration.PLATFORM_URL];

    if (discovered) {
      trustedOrigins.push(new URL(discovered.issuer).origin);

      if (new URL(discovered.issuer).hostname === "login.microsoftonline.com")
        trustedOrigins.push("https://graph.microsoft.com");
    }

    await organizationOperation(
      database,
      {
        auth: betterAuth({
          ...credential.auth.options,
          trustedOrigins: async (_request: Request | undefined) => trustedOrigins,
        }),
        headers: credential.headers,
      },
      async (api, headers) => {
        if (replace && existing)
          await api.deleteSSOProvider({ headers, body: { providerId: existing.providerId } });

        if (!identity || !discovered || !oidcConfig || !providerId) return;

        if (existing && !replace)
          await api.updateSSOProvider({
            headers,
            body: {
              providerId,
              issuer: discovered.issuer,
              domain: identity.domain ?? "",
              oidcConfig,
            },
          });
        else
          await api.registerSSOProvider({
            headers,
            body: {
              providerId,
              organizationId,
              issuer: discovered.issuer,
              domain: identity.domain ?? "",
              oidcConfig,
            },
          });
      },
    );
  } else {
    // Bootstrap uses the plugin's schema transforms without fabricating a session.
    if (replace && existing) {
      await adapter.deleteMany({
        model: "account",
        where: [{ field: "providerId", value: existing.providerId }],
      });
      await adapter.delete({ model: "ssoProvider", where: [{ field: "id", value: existing.id }] });
    }

    if (identity && discovered && oidcConfig && providerId) {
      const fields = {
        providerId,
        organizationId,
        issuer: discovered.issuer,
        domain: identity.domain,
        domainVerified: !replace && existing?.domainVerified === true,
        oidcConfig: JSON.stringify(oidcConfig),
      };

      if (existing && !replace)
        await adapter.update({
          model: "ssoProvider",
          where: [{ field: "id", value: existing.id }],
          update: fields,
        });
      else
        await adapter.create({
          model: "ssoProvider",
          data: { id: crypto.randomUUID(), ...fields },
          forceAllowId: true,
        });
    }
  }

  if (replace) {
    // A provider replacement ends that company's login authority. Existing JWTs
    // have a five-minute lifetime; their refresh grants are removed immediately.
    await database
      .delete(oauthRefreshToken)
      .where(eq(oauthRefreshToken.referenceId, authenticationReference("", organizationId)));
    await database
      .delete(session)
      .where(and(eq(session.identityOrganizationId, organizationId), eq(session.recovery, false)));
  }

  const saved = await readSsoProvider(database, organizationId);

  return identity && saved
    ? { clientId: identity.management.clientId, secret: { type: "stored" as const, id: saved.id } }
    : null;
};
