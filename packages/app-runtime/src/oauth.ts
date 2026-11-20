import { runWithEndpointContext } from "@better-auth/core/context";
import { createLogger } from "@better-auth/core/env";
import type { OAuth2Tokens, OAuthProvider, ProviderOptions } from "@better-auth/core/oauth2";
import { socialProviders } from "@better-auth/core/social-providers";
import { appCaller } from "@platform/contracts";
import { z } from "zod";
import { decryptText, encryptText } from "./secrets.ts";
import {
  managedOAuthConfiguration,
  oauthRequest,
  type managedOAuthClient,
  type OAuthRequest,
} from "./oauth-protocol.ts";

// The operator's client secret is shared by every organization, so it is only
// sent in requests this broker builds from the operator's configuration. Apps
// receive sealed refresh tokens bound to app and caller, and access tokens as
// placeholders that the network gateway substitutes for the operator's hosts.

const ownership = z.object({
  appId: z.uuid(),
  organizationId: z.string().min(1),
  origin: z.url(),
  caller: appCaller.pick({ issuer: true, subject: true }).strip(),
  client: z.string(),
  clientId: z.string(),
});

const transaction = ownership.extend({
  state: z.string(),
  codeVerifier: z.string(),
  expiresAt: z.number(),
});

const refreshGrant = ownership.extend({ token: z.string().min(1).max(3000) });

const accessGrant = z.object({
  appId: z.uuid(),
  organizationId: z.string().min(1),
  client: z.string(),
  hosts: z.array(z.string()),
  token: z.string().min(1).max(20000),
});

const accessTokenPrefix = "wft1.";

type Environment = { WIDEFLEET_SECRETS_KEY: string; WIDEFLEET_OAUTH?: string };

type Client = z.infer<typeof managedOAuthClient>;

export type OAuthIdentity = Omit<z.infer<typeof ownership>, "client" | "clientId">;

const configuration = (environment: Environment) => {
  if (!environment.WIDEFLEET_OAUTH) return null;

  try {
    return managedOAuthConfiguration.parse(JSON.parse(environment.WIDEFLEET_OAUTH));
  } catch {
    // JSON parser errors may include secret values from the input.
    throw new Error("Managed OAuth configuration is invalid");
  }
};

const callbackPath = (client: string) => `/oauth/callback/${client}`;

// Sealed values keep their earlier encoding. They hold provider tokens, so they
// are not limited to the size of an app secret.
const seal = (environment: Environment, purpose: string, payload: string) =>
  encryptText(environment, `managed-oauth/${purpose}/v1`, JSON.stringify({ payload }));

const open = async (environment: Environment, purpose: string, value: string) =>
  z
    .object({ payload: z.string() })
    .parse(JSON.parse(await decryptText(environment, `managed-oauth/${purpose}/v1`, value)))
    .payload;

// Provider modules log token endpoint failures with the provider's response,
// whose descriptions can contain credentials.
const silent = createLogger({ disabled: true });

const quietly = <T>(operation: () => Promise<T>) =>
  runWithEndpointContext(
    // SAFETY: Better Auth's provider modules read only the logger from this context.
    { context: { logger: silent } } as Parameters<typeof runWithEndpointContext>[0],
    operation,
  );

const provider = (client: Client) =>
  // SAFETY: Every social provider takes the shared provider options; provider-specific
  // options come from the operator's configuration.
  (socialProviders[client.provider] as (options: ProviderOptions) => OAuthProvider)({
    ...client.options,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  });

// RFC 6749 separates scopes with spaces; GitHub reports them with commas.
const scopeList = (value: string | null | undefined) =>
  (value ?? "").split(/[\s,]+/).filter(Boolean);

const disallowed = (client: Client, scopes: readonly string[]) =>
  scopes.filter((scope) => !client.scopes.includes(scope));

const requireOwner = (actual: z.infer<typeof ownership>, expected: z.infer<typeof ownership>) => {
  if (
    actual.appId !== expected.appId ||
    actual.organizationId !== expected.organizationId ||
    actual.origin !== expected.origin ||
    actual.client !== expected.client ||
    actual.clientId !== expected.clientId ||
    actual.caller.issuer !== expected.caller.issuer ||
    actual.caller.subject !== expected.caller.subject
  )
    throw new Error("OAuth grant belongs to another app, user or registration");
};

const sameText = async (left: string, right: string) => {
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

  const [a, b] = await Promise.all([digest(left), digest(right)]);

  return a.every((byte, index) => byte === b[index]);
};

const issuerMatches = (expected: string, actual: string) => {
  const [prefix, suffix, ...rest] = expected.split("{tenantid}");

  if (suffix === undefined || rest.length > 0) return actual === expected;

  return (
    actual.startsWith(prefix ?? "") &&
    actual.endsWith(suffix) &&
    /^[A-Za-z0-9._-]+$/.test(actual.slice((prefix ?? "").length, actual.length - suffix.length))
  );
};

const revoke = async (client: Client, token: string) => {
  if (!client.revocationUrl) return false;

  const response = await fetch(client.revocationUrl, {
    method: "POST",
    body: new URLSearchParams({
      token,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });

  await response.body?.cancel();

  return response.ok;
};

/**
 * The real access token behind a placeholder, when the placeholder belongs to
 * this app and the request goes to one of its client's hosts.
 */
export const openAccessToken = async (
  environment: Environment,
  appId: string,
  placeholder: string,
  target: URL,
) => {
  if (!placeholder.startsWith(accessTokenPrefix)) return null;
  let grant;

  try {
    grant = accessGrant.parse(
      JSON.parse(await open(environment, "access", placeholder.slice(accessTokenPrefix.length))),
    );
  } catch {
    return null;
  }

  if (grant.appId !== appId || !grant.hosts.includes(target.origin)) return null;
  let client;

  try {
    client = configuration(environment)?.clients[grant.client];
  } catch {
    return null;
  }

  // The operator can withdraw a client or a host from tokens it already issued.
  return client?.hosts.includes(target.origin) ? grant.token : null;
};

export const isAccessTokenPlaceholder = (value: string) => value.startsWith(accessTokenPrefix);

export const managedOAuth = (environment: Environment) => ({
  async request(identity: OAuthIdentity, input: OAuthRequest) {
    const request = oauthRequest.parse(input);
    const config = configuration(environment);
    const client = config?.clients[request.client];

    if (request.action === "configuration")
      return client ? { clientId: client.clientId, scopes: client.scopes } : null;

    if (!client || !config) throw new Error("Managed OAuth client is not configured");

    const owner = ownership.parse({
      ...identity,
      client: request.client,
      clientId: client.clientId,
    });

    const redirectURI = `${config.origin}${callbackPath(request.client)}`;
    const oauth = provider(client);

    const present = async (tokens: OAuth2Tokens | null, previousRefreshToken?: string) => {
      if (!tokens?.accessToken) throw new Error("OAuth provider returned no usable token");
      const granted = (tokens.scopes ?? []).flatMap((scope) => scopeList(scope));

      if (disallowed(client, granted).length > 0) {
        await revoke(client, tokens.refreshToken ?? tokens.accessToken).catch(() => false);
        throw new Error("OAuth provider granted scopes this client does not allow");
      }

      const accessToken = await seal(
        environment,
        "access",
        JSON.stringify(
          accessGrant.parse({
            appId: owner.appId,
            organizationId: owner.organizationId,
            client: owner.client,
            hosts: client.hosts,
            token: tokens.accessToken,
          }),
        ),
      );

      return {
        accessToken: `${accessTokenPrefix}${accessToken}`,
        refreshToken: tokens.refreshToken
          ? await seal(
              environment,
              "refresh",
              JSON.stringify(refreshGrant.parse({ ...owner, token: tokens.refreshToken })),
            )
          : previousRefreshToken,
        idToken: tokens.idToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        scopes: granted,
        tokenType: tokens.tokenType ?? "Bearer",
      };
    };

    if (request.action === "authorize") {
      if (disallowed(client, request.scopes).length > 0)
        throw new Error("The requested scopes are not allowed for this client");

      const ticket = await seal(
        environment,
        "state",
        JSON.stringify(
          transaction.parse({
            ...owner,
            state: request.state,
            codeVerifier: request.codeVerifier,
            expiresAt: Date.now() + 600_000,
          }),
        ),
      );

      const url = await quietly(async () =>
        oauth.createAuthorizationURL({
          state: ticket,
          codeVerifier: request.codeVerifier,
          scopes: request.scopes,
          redirectURI,
        }),
      );

      // Providers add their default scopes; the operator must allow those too.
      if (disallowed(client, scopeList(url.searchParams.get("scope"))).length > 0)
        throw new Error("The provider requests scopes this client does not allow");

      return { url: url.href };
    }

    if (request.action === "exchange") {
      const pending = transaction.parse(
        JSON.parse(await open(environment, "state", request.ticket)),
      );

      requireOwner(pending, owner);

      if (
        pending.expiresAt <= Date.now() ||
        !(await sameText(request.codeVerifier, pending.codeVerifier))
      )
        throw new Error("OAuth transaction expired or PKCE verifier does not match");

      return present(
        await quietly(() =>
          oauth.validateAuthorizationCode({
            code: request.code,
            codeVerifier: pending.codeVerifier,
            redirectURI,
          }),
        ),
      );
    }

    if (request.action === "refresh") {
      const grant = refreshGrant.parse(
        JSON.parse(await open(environment, "refresh", request.refreshToken)),
      );

      requireOwner(grant, owner);
      const refresh = oauth.refreshAccessToken;

      if (!refresh) throw new Error("This OAuth provider does not refresh access tokens");

      return present(await quietly(() => refresh(grant.token)), request.refreshToken);
    }

    if (isAccessTokenPlaceholder(request.token)) {
      const grant = accessGrant.parse(
        JSON.parse(
          await open(environment, "access", request.token.slice(accessTokenPrefix.length)),
        ),
      );

      if (
        grant.appId !== owner.appId ||
        grant.organizationId !== owner.organizationId ||
        grant.client !== owner.client
      )
        throw new Error("OAuth grant belongs to another app or registration");

      return { revoked: await revoke(client, grant.token) };
    }

    const grant = refreshGrant.parse(JSON.parse(await open(environment, "refresh", request.token)));

    requireOwner(grant, owner);

    return { revoked: await revoke(client, grant.token) };
  },

  async callback(request: Request, available: (identity: OAuthIdentity) => Promise<boolean>) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/oauth/callback/")) return null;
    let config;

    try {
      config = configuration(environment);
    } catch {
      // An optional OAuth configuration must not prevent normal app routing.
      return null;
    }

    if (!config || url.origin !== config.origin) return null;
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

    if (request.method !== "GET" || url.href.length > 20000)
      return new Response("Invalid OAuth callback", { status: 400, headers });

    try {
      const ticket = z.string().min(1).max(12000).parse(url.searchParams.get("state"));
      const pending = transaction.parse(JSON.parse(await open(environment, "state", ticket)));
      const client = config.clients[pending.client];

      if (
        !client ||
        url.pathname !== callbackPath(pending.client) ||
        pending.expiresAt <= Date.now() ||
        client.clientId !== pending.clientId ||
        !(await available(pending))
      )
        throw new Error("OAuth transaction is not available");
      const issuer = url.searchParams.get("iss");

      if (issuer && client.issuer && !issuerMatches(client.issuer, issuer))
        throw new Error("Unexpected OAuth issuer");
      const target = new URL(`/auth/callback/${client.provider}`, pending.origin);
      target.searchParams.set("state", pending.state);
      target.searchParams.set("managed_state", ticket);

      if (url.searchParams.has("error")) target.searchParams.set("error", "access_denied");
      else
        target.searchParams.set(
          "code",
          z.string().min(1).max(4096).parse(url.searchParams.get("code")),
        );

      return new Response(null, { status: 303, headers: { ...headers, location: target.href } });
    } catch {
      return new Response("Invalid or expired OAuth callback. Start again from the app.", {
        status: 400,
        headers,
      });
    }
  },
});
