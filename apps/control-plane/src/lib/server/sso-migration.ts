import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { companyProvider, installationSettings, secretReference } from "@platform/contracts";
import { ssoProvider } from "./auth-schema.ts";
import { organizationSecrets, organizationSettings } from "./schema.ts";
import type { Database } from "./database.ts";
import { decryptSecret, encryptSecret } from "./secret-encryption.ts";
import { companyAccountProvider, providerIssuer } from "./company-identity.ts";

const legacyClient = z.object({ clientId: z.string(), secret: secretReference });

const legacySettings = z.object({
  externallyManaged: z.boolean(),
  identity: z
    .object({
      provider: companyProvider,
      domain: z.string().nullable().optional(),
      management: legacyClient,
      directory: legacyClient.nullable(),
    })
    .nullable(),
});

// One-time conversion of the pre-plugin configuration. Subsequent reads and
// writes use only the native provider; the old editable identity document is removed.
export const migrateSsoSettings = async (database: Database, key: string) => {
  await database.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(organizationSettings)
      .where(sql`${organizationSettings.settings} ? 'identity'`)
      .for("update");

    for (const row of rows) {
      const old = legacySettings.parse(row.settings);
      const identity = old.identity;
      const provider = identity?.provider;

      if (identity && provider) {
        const [existing] = await transaction
          .select()
          .from(ssoProvider)
          .where(eq(ssoProvider.organizationId, row.organizationId));

        if (!existing) {
          const [secret] = await transaction
            .select()
            .from(organizationSecrets)
            .where(
              and(
                eq(organizationSecrets.id, identity.management.secret.id),
                eq(organizationSecrets.organizationId, row.organizationId),
              ),
            );

          if (!secret) throw new Error("The saved company SSO credential is missing");
          const clientSecret = await decryptSecret(key, secret.ciphertext);
          await transaction.insert(ssoProvider).values({
            id: crypto.randomUUID(),
            organizationId: row.organizationId,
            providerId: companyAccountProvider(identity, row.organizationId),
            issuer: providerIssuer(provider),
            domain: identity.domain ?? "",
            // Earlier configurations did not establish ownership of an email domain.
            domainVerified: false,
            oidcConfig: await encryptSecret(
              key,
              JSON.stringify({
                issuer: providerIssuer(provider),
                clientId: identity.management.clientId,
                clientSecret,
                pkce: true,
                scopes: ["openid", "profile", "email"],
                mapping:
                  provider.type === "oidc"
                    ? { name: provider.nameClaim, email: provider.emailClaim }
                    : { name: "name", email: "email" },
              }),
            ),
          });
        }
      }

      const settings = installationSettings.parse({
        externallyManaged: old.externallyManaged,
        appIdentity:
          provider?.type === "entra"
            ? { type: "entra" }
            : { type: "oidc", groupsClaim: provider?.groupsClaim ?? "groups" },
        directory: identity?.directory ?? null,
      });

      await transaction
        .update(organizationSettings)
        .set({ settings })
        .where(eq(organizationSettings.organizationId, row.organizationId));
      await transaction
        .delete(organizationSecrets)
        .where(
          and(
            eq(organizationSecrets.organizationId, row.organizationId),
            settings.directory
              ? sql`${organizationSecrets.id} <> ${settings.directory.secret.id}`
              : undefined,
          ),
        );
    }
  });
};
