import { z } from "zod";

export const identityUrl = z.url().refine((value) => {
  const url = new URL(value);

  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}, "Use HTTPS, or HTTP on loopback for a local identity provider");

const claimName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/);

export const companyProvider = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("entra"),
    tenantId: z.uuid(),
    authority: identityUrl
      .refine((value) => new URL(value).origin === value, "Use an authority origin")
      .default("https://login.microsoftonline.com"),
    label: z.string().min(1).max(100).default("Microsoft Entra"),
  }),
  z.strictObject({
    type: z.literal("oidc"),
    issuer: identityUrl,
    label: z.string().min(1).max(100),
    groupsClaim: claimName.default("groups"),
    organizationClaim: claimName.optional(),
    nameClaim: claimName.default("name"),
    emailClaim: claimName.default("email"),
  }),
]);

const client = z.strictObject({ clientId: z.string().min(1).max(512) });

const clientInput = client.extend({ clientSecret: z.string().min(1).max(16_384).optional() });

export const companyDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Enter the company's email domain, without a URL or wildcard",
  );

// These settings describe app access claims, not the company's SSO connection.
// Issuer, client credentials and profile mappings belong to the native SSO provider.
export const appIdentitySettings = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("entra") }),
  z.strictObject({
    type: z.literal("oidc"),
    groupsClaim: claimName.default("groups"),
  }),
]);

export const oidcProviderInput = z.strictObject({
  providerId: z.string().min(1),
  issuer: identityUrl,
  domain: companyDomain,
  oidcConfig: z.strictObject({
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(16_384).optional(),
    pkce: z.boolean().default(true),
    scopes: z.array(z.string()).default(["openid", "profile", "email"]),
    mapping: z
      .object({
        name: claimName.default("name"),
        email: claimName.default("email"),
      })
      .default({ name: "name", email: "email" }),
  }),
});

export const installationSettings = z.strictObject({
  appIdentity: appIdentitySettings.default({ type: "oidc", groupsClaim: "groups" }),
  directory: client.nullable().default(null),
  externallyManaged: z.boolean().default(false),
});

export const settingsInput = installationSettings.extend({
  directory: clientInput.nullable().default(null),
  sso: oidcProviderInput.nullable(),
});

export const settingsUpdate = settingsInput.extend({
  acknowledgeRestart: z.boolean().default(false),
});

export const setupOwner = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(12).max(128),
});

export const bootstrapConfiguration = z.strictObject({
  owner: setupOwner,
  settings: settingsInput.optional(),
});

export const activationStatus = z.strictObject({
  revision: z.string(),
  state: z.enum(["waiting", "applying", "active", "failed"]),
  message: z.string(),
});

export const settingsView = z.strictObject({
  settings: installationSettings,
  ssoRequired: z.boolean(),
  localPasswordEnabled: z.boolean(),
  managementCallbackUrl: z.string().nullable(),
  appCallbackUrl: z.url(),
  activation: activationStatus,
  error: z.string().nullable(),
  sso: oidcProviderInput
    .extend({ domain: z.union([companyDomain, z.literal("")]), domainVerified: z.boolean() })
    .nullable(),
});

export const domainVerification = z.object({
  name: z.string(),
  type: z.literal("TXT"),
  value: z.string(),
});

export const settingsPlan = z.strictObject({
  restartRequired: z.boolean(),
  message: z.string(),
});
