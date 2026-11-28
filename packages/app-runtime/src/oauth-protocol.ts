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

const endpoint = z.url().startsWith("https://");

// Settings every managed client shares. The operator decides which scopes apps
// may request and which API origins its access tokens reach. A service without
// scopes, such as Notion, whose integration settings decide its access, lists none.
const clientPolicy = {
  scopes: z.array(scope),
  hosts: z.array(origin("Access token hosts must be canonical HTTPS origins")).min(1),
  // The issuer a callback's `iss` parameter must name (RFC 9207). `{tenantid}`
  // stands for one tenant ID, as Microsoft's multi-tenant issuers publish it.
  issuer: endpoint.optional(),
  // RFC 7009 token revocation, used when a user disconnects an account.
  revocationUrl: endpoint.optional(),
  // How a registered client authenticates there: with its credentials in the
  // form, or with HTTP Basic authentication, which Notion requires.
  revocationAuthentication: z.enum(["form", "basic"]).optional(),
};

/**
 * An OAuth client the operator registered with a service. Its provider is one
 * of Better Auth's social providers, which implement each service's protocol
 * details, with optional provider options such as `accessType` for Google or
 * `tenantId` for Microsoft.
 */
export const registeredOAuthClient = z.strictObject({
  provider: z.enum(socialProviderList),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(2048),
  options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  ...clientPolicy,
});

/**
 * A service whose authorization server accepts OAuth Client ID Metadata
 * Documents. Nothing is registered with the service: the installation's client
 * ID is the URL of the document it publishes on the managed OAuth origin, and
 * the client authenticates with PKCE alone. The operator names the server's
 * endpoints, which its metadata advertises with
 * `client_id_metadata_document_supported`, and the protected resource the
 * tokens are for (RFC 8707), as MCP servers require.
 */
export const metadataDocumentOAuthClient = z.strictObject({
  registration: z.literal("client-id-metadata-document"),
  authorizationUrl: endpoint,
  tokenUrl: endpoint,
  resource: endpoint.optional(),
  ...clientPolicy,
});

export const managedOAuthClient = z.union([registeredOAuthClient, metadataDocumentOAuthClient]);

export const managedOAuthClientName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const managedOAuthConfiguration = z.strictObject({
  origin: origin("Managed OAuth requires a canonical HTTPS origin"),
  // The client name authorization servers show for Client ID Metadata Document clients.
  clientName: z.string().trim().min(1).max(100).default("Widefleet"),
  clients: z.record(managedOAuthClientName, managedOAuthClient),
});

/** Where the installation publishes its OAuth Client ID Metadata Document. */
export const clientMetadataDocumentPath = "/oauth/client-metadata.json";

export const oauthRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("configuration"), client: managedOAuthClientName }),
  z.strictObject({
    action: z.literal("authorize"),
    client: managedOAuthClientName,
    scopes: z.array(scope).max(64),
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
