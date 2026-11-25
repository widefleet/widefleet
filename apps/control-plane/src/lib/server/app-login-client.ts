import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { organizationIdentifier } from "@platform/contracts";
import type { Configuration } from "./config.ts";
import type { DatabaseExecutor } from "./database.ts";
import { companyIdentity } from "./company-identity.ts";
import { oauthClient } from "./auth-schema.ts";
import { organizationSettings } from "./schema.ts";
import { appCallbackUrl } from "./app-sign-in.ts";
import type { SecretEncryption } from "./secret-encryption.ts";

export const hashAppClientSecret = async (value: string) =>
  createHash("sha256").update(value).digest("base64url");

export const appLoginClientId = (organizationId: string) =>
  `apps-${organizationIdentifier.parse(organizationId)}`;

export const registerAppLogin = async (
  database: DatabaseExecutor,
  configuration: Configuration,
  encryption: SecretEncryption,
  organizationId: string,
) => {
  const [settings] = await database
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .for("update");

  if (!settings) throw new Error("Initialize organization settings before app sign-in");

  const secret = settings.appClientSecret
    ? await encryption.decrypt(
        { kind: "app-login-client-secret", organizationId },
        settings.appClientSecret,
      )
    : randomBytes(32).toString("base64url");

  if (!settings.appClientSecret)
    await database
      .update(organizationSettings)
      .set({
        appClientSecret: await encryption.encrypt(
          { kind: "app-login-client-secret", organizationId },
          secret,
        ),
      })
      .where(eq(organizationSettings.organizationId, organizationId));
  const clientId = appLoginClientId(organizationId);

  const registration = {
    clientId,
    clientSecret: await hashAppClientSecret(secret),
    name: "Widefleet app sign-in",
    applicationType: "web",
    tokenEndpointAuthMethod: "client_secret_post",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopes: ["openid", "profile", "email", "offline_access"],
    redirectUris: [appCallbackUrl(configuration, organizationId)],
    requirePKCE: true,
    skipConsent: true,
    disabled: false,
    metadata: { purpose: "app-login", organizationId },
    updatedAt: new Date(),
  };

  await database
    .insert(oauthClient)
    .values({ id: crypto.randomUUID(), createdAt: new Date(), ...registration })
    .onConflictDoUpdate({ target: oauthClient.clientId, set: registration });
};

export const readAppLogin = async (
  database: DatabaseExecutor,
  configuration: Configuration,
  encryption: SecretEncryption,
  organizationId: string,
) => {
  const [settings] = await database
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId));

  if (!settings?.appClientSecret) return null;
  const clientId = appLoginClientId(organizationId);

  const clientSecret = await encryption.decrypt(
    { kind: "app-login-client-secret", organizationId },
    settings.appClientSecret,
  );

  return companyIdentity.parse({
    provider: {
      type: "oidc",
      issuer: `${configuration.PLATFORM_URL}/api/auth`,
      label: "Widefleet",
      organizationClaim: "organization_id",
      sendTokenRequestOrigin: true,
    },
    management: { clientId, clientSecret },
    directory: null,
  });
};
