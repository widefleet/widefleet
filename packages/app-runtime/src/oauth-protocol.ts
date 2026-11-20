import { socialProviderList } from "@better-auth/core/social-providers";
import { z } from "zod";

// An exact HTTPS origin, as network policies name them.
const origin = (message: string) =>
  z.url().refine((value) => {
    const url = new URL(value);

    return url.protocol === "https:" && url.origin === value;
  }, message);

// RFC 6749 scope-token characters.
const scope = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);

/**
 * An OAuth client the operator provides. Its provider is one of Better Auth's
 * social providers, which implement each service's protocol details. The
 * operator decides which scopes apps may request, which API origins its access
 * tokens reach, and optional provider options such as `accessType` for Google
 * or `tenantId` for Microsoft.
 */
export const managedOAuthClient = z.strictObject({
  provider: z.enum(socialProviderList),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(2048),
  scopes: z.array(scope).min(1),
  hosts: z.array(origin("Access token hosts must be canonical HTTPS origins")).min(1),
  options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  // The issuer a callback's `iss` parameter must name (RFC 9207). `{tenantid}`
  // stands for one tenant ID, as Microsoft's multi-tenant issuers publish it.
  issuer: z.url().startsWith("https://").optional(),
  // RFC 7009 token revocation, used when a user disconnects an account.
  revocationUrl: z.url().startsWith("https://").optional(),
});

export const managedOAuthClientName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const managedOAuthConfiguration = z.strictObject({
  origin: origin("Managed OAuth requires a canonical HTTPS origin"),
  clients: z.record(managedOAuthClientName, managedOAuthClient),
});

export const oauthRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("configuration"), client: managedOAuthClientName }),
  z.strictObject({
    action: z.literal("authorize"),
    client: managedOAuthClientName,
    scopes: z.array(scope).min(1).max(64),
    state: z.string().min(1).max(256),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  }),
  z.strictObject({
    action: z.literal("exchange"),
    client: managedOAuthClientName,
    ticket: z.string().min(1).max(12000),
    code: z.string().min(1).max(4096),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  }),
  z.strictObject({
    action: z.literal("refresh"),
    client: managedOAuthClientName,
    refreshToken: z.string().min(1).max(12000),
  }),
  z.strictObject({
    action: z.literal("revoke"),
    client: managedOAuthClientName,
    token: z.string().min(1).max(30000),
  }),
]);

export type OAuthRequest = z.infer<typeof oauthRequest>;
