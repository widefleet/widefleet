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

const domainName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const companyDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(domainName, "Enter the company's email domain, without a URL or wildcard");

export const maxCompanyDomains = 20;

export const parseCompanyDomains = (value: string) =>
  value
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

// Settings files list every company email domain in one comma-separated value.
export const companyDomains = z
  .string()
  .overwrite((value) => parseCompanyDomains(value).join(","))
  .refine(
    (value) =>
      value !== "" &&
      value.split(",").every((domain) => domain.length <= 253 && domainName.test(domain)),
    "Enter the company's email domains separated by commas, without a URL or wildcard",
  )
  .refine(
    (value) => new Set(value.split(",")).size === value.split(",").length,
    "Enter each company email domain once",
  )
  .refine(
    (value) => value.split(",").length <= maxCompanyDomains,
    `Enter at most ${maxCompanyDomains} company email domains`,
  );

export const companyProvider = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("google"),
    issuer: z.literal("https://accounts.google.com").default("https://accounts.google.com"),
    domain: companyDomain,
    label: z.string().min(1).max(100).default("Google Workspace"),
  }),
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
    // Widefleet's form-encoded token endpoint requires its own Origin header.
    sendTokenRequestOrigin: z.boolean().optional(),
    nameClaim: claimName.default("name"),
    emailClaim: claimName.default("email"),
  }),
]);

const client = z.strictObject({
  clientId: z.string().min(1).max(512),
});

const clientInput = client.extend({ clientSecret: z.string().min(1).max(16_384).optional() });

export const googleGroupsScope = "https://www.googleapis.com/auth/cloud-identity.groups.readonly";

export const oidcProviderInput = z.strictObject({
  providerId: z.string().min(1),
  appIdentityType: z.enum(["oidc", "entra", "google"]).default("oidc"),
  issuer: identityUrl,
  // An omitted list preserves saved domains; an empty list is allowed only by
  // the operator-trusted self-hosted policy, enforced by the settings service.
  domain: companyDomains.or(z.literal("")).optional(),
  oidcConfig: z.strictObject({
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(16_384).optional(),
    pkce: z.boolean().default(true),
    scopes: z.array(z.string()).default(["openid", "profile", "email"]),
    mapping: z
      .object({
        name: claimName.default("name"),
        email: claimName.default("email"),
        extraFields: z
          .object({ groups: claimName.default("groups") })
          .default({ groups: "groups" }),
      })
      .default({ name: "name", email: "email", extraFields: { groups: "groups" } }),
  }),
});

export const installationSettings = z.strictObject({
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
  organizationName: z.string().trim().min(1).max(200).optional(),
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

const domainVerificationRecord = z.object({
  domain: z.string(),
  name: z.string(),
  type: z.literal("TXT"),
  value: z.string(),
});

export const ssoDomain = z.strictObject({
  domain: z.string(),
  verified: z.boolean(),
  record: domainVerificationRecord.omit({ domain: true }).nullable(),
});

export const ssoDomainInput = z.strictObject({ domain: companyDomain });

export const settingsView = z.strictObject({
  settings: installationSettings,
  ssoDomains: z.array(ssoDomain),
  ssoRequired: z.boolean(),
  ssoPolicy: z.strictObject({
    domainVerificationRequired: z.boolean(),
    allowEmailAccountLinking: z.boolean(),
  }),
  managementCallbackUrl: z.string().nullable(),
  appCallbackUrl: z.url(),
  activation: activationStatus,
  error: z.string().nullable(),
  sso: oidcProviderInput
    .extend({ domain: z.union([companyDomains, z.literal("")]), domainVerified: z.boolean() })
    .nullable(),
});

// Lists pending domains. The top-level record is the first one's, kept for clients
// that predate `records`.
export const domainVerification = domainVerificationRecord.omit({ domain: true }).extend({
  records: z.array(domainVerificationRecord).min(1),
});

export const settingsPlan = z.strictObject({
  restartRequired: z.boolean(),
  message: z.string(),
});
