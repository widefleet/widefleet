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
    subjectClaim: claimName.default("sub"),
    nameClaim: claimName.default("name"),
    emailClaim: claimName.default("email"),
  }),
]);

// External providers can be added here without changing the settings that use secrets.
export const secretReference = z.strictObject({ type: z.literal("stored"), id: z.uuid() });

export const secretInput = z.union([
  secretReference,
  z.strictObject({ type: z.literal("value"), value: z.string().min(1).max(16_384) }),
]);

const client = z.strictObject({ clientId: z.string().min(1).max(512), secret: secretReference });

const clientInput = client.extend({ secret: secretInput });

export const identitySettings = z
  .strictObject({
    provider: companyProvider,
    management: client,
    apps: client,
    directory: client.nullable().default(null),
  })
  .refine((value) => !value.directory || value.provider.type === "entra", {
    message: "Microsoft Graph directory search requires an Entra provider",
    path: ["directory"],
  });

export const identitySettingsInput = z
  .strictObject({
    provider: companyProvider,
    management: clientInput,
    apps: clientInput,
    directory: clientInput.nullable().default(null),
  })
  .refine((value) => !value.directory || value.provider.type === "entra", {
    message: "Microsoft Graph directory search requires an Entra provider",
    path: ["directory"],
  });

export const installationSettings = z.strictObject({
  identity: identitySettings.nullable().default(null),
  externallyManaged: z.boolean().default(false),
});

export const settingsInput = z.strictObject({
  identity: identitySettingsInput.nullable(),
  externallyManaged: z.boolean(),
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
  localPasswordEnabled: z.boolean(),
  managementCallbackUrl: z.string().nullable(),
  appCallbackUrl: z.url(),
  activation: activationStatus,
  error: z.string().nullable(),
});

export const settingsPlan = z.strictObject({
  restartRequired: z.boolean(),
  message: z.string(),
});
