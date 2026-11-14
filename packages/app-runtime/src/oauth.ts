import { appCaller } from "@platform/contracts";
import { z } from "zod";
import { decryptSecrets, encryptSecrets } from "./secrets.ts";
import {
  managedOAuthConfiguration,
  oauthProvider,
  oauthRequest,
  type OAuthRequest,
} from "./oauth-protocol.ts";

const providers = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    issuer: /^https:\/\/accounts\.google\.com$/,
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly"],
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    issuer: /^https:\/\/github\.com$/,
    scopes: ["read:user", "user:email", "repo"],
  },
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    issuer: /^https:\/\/login\.microsoftonline\.com\/(?:common|[a-f0-9-]{36})\/v2\.0$/i,
    scopes: ["openid", "profile", "email", "offline_access", "User.Read", "Files.Read"],
  },
};

const ownership = z.object({
  appId: z.uuid(),
  organizationId: z.string().min(1),
  origin: z.url(),
  caller: appCaller.pick({ issuer: true, subject: true }).strip(),
  provider: oauthProvider,
  clientId: z.string(),
});

const transaction = ownership.extend({
  state: z.string(),
  codeChallenge: z.string(),
  expiresAt: z.number(),
});

const refreshGrant = ownership.extend({ token: z.string().min(1).max(3000) });

const tokenResponse = z.object({
  access_token: z.string().min(1).max(20000),
  refresh_token: z.string().min(1).max(3000).optional(),
  id_token: z.string().max(20000).optional(),
  expires_in: z.number().positive().optional(),
  refresh_token_expires_in: z.number().positive().optional(),
  scope: z.string().max(4000).optional(),
  token_type: z.string().optional(),
});

type Environment = { WIDEFLEET_SECRETS_KEY: string; WIDEFLEET_OAUTH?: string };

export type OAuthIdentity = Omit<z.infer<typeof ownership>, "provider" | "clientId">;

const configuration = (environment: Environment) =>
  environment.WIDEFLEET_OAUTH
    ? managedOAuthConfiguration.parse(JSON.parse(environment.WIDEFLEET_OAUTH))
    : null;

const callbackPath = (provider: z.infer<typeof oauthProvider>) => `/oauth/callback/${provider}`;

const challenge = async (verifier: string) =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const seal = (environment: Environment, purpose: string, payload: string) =>
  encryptSecrets(environment, `managed-oauth/${purpose}/v1`, { payload });

const open = async (environment: Environment, purpose: string, value: string) => {
  const data = await decryptSecrets(environment, `managed-oauth/${purpose}/v1`, value);

  return z.string().parse(data["payload"]);
};

const requireOwner = (actual: z.infer<typeof ownership>, expected: z.infer<typeof ownership>) => {
  if (
    actual.appId !== expected.appId ||
    actual.organizationId !== expected.organizationId ||
    actual.origin !== expected.origin ||
    actual.provider !== expected.provider ||
    actual.clientId !== expected.clientId ||
    actual.caller.issuer !== expected.caller.issuer ||
    actual.caller.subject !== expected.caller.subject
  )
    throw new Error("OAuth grant belongs to another app, user or registration");
};

export const managedOAuth = (environment: Environment, transport: typeof fetch = fetch) => ({
  async request(identity: OAuthIdentity, input: OAuthRequest) {
    const request = oauthRequest.parse(input);
    const config = configuration(environment);
    const client = config?.providers[request.provider];

    if (request.action === "configuration") return client ? { clientId: client.clientId } : null;

    if (!client || !config) throw new Error("Managed OAuth provider is not configured");

    const owner = ownership.parse({
      ...identity,
      provider: request.provider,
      clientId: client.clientId,
    });

    const provider = providers[request.provider];
    const redirect = `${config.origin}${callbackPath(request.provider)}`;

    if (request.action === "authorize") {
      const ticket = await seal(
        environment,
        "state",
        JSON.stringify(
          transaction.parse({
            ...owner,
            state: request.state,
            codeChallenge: request.codeChallenge,
            expiresAt: Date.now() + 600_000,
          }),
        ),
      );

      const url = new URL(provider.authorize);
      url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: provider.scopes.join(" "),
        state: ticket,
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
      }).toString();

      if (request.provider === "google") {
        url.searchParams.set("access_type", "offline");
        url.searchParams.set("prompt", "select_account consent");
      }

      return { url: url.href };
    }

    const body = new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });

    if (request.action === "exchange") {
      const pending = transaction.parse(
        JSON.parse(await open(environment, "state", request.ticket)),
      );

      requireOwner(pending, owner);

      if (
        pending.expiresAt <= Date.now() ||
        (await challenge(request.codeVerifier)) !== pending.codeChallenge
      )
        throw new Error("OAuth transaction expired or PKCE verifier does not match");
      body.set("grant_type", "authorization_code");
      body.set("code", request.code);
      body.set("code_verifier", request.codeVerifier);
      body.set("redirect_uri", redirect);
    } else {
      const grant = refreshGrant.parse(
        JSON.parse(await open(environment, "refresh", request.refreshToken)),
      );

      requireOwner(grant, owner);
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", grant.token);
    }

    const response = await transport(provider.token, {
      method: "POST",
      body,
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) throw new Error("OAuth provider token request failed");
    const result = tokenResponse.safeParse(await response.json().catch(() => null));

    // Provider error descriptions can contain credentials. Never expose them to logs or callers.
    if (!result.success) throw new Error("OAuth provider returned no usable token");
    const tokens = result.data;

    const refreshToken = tokens.refresh_token
      ? await seal(
          environment,
          "refresh",
          JSON.stringify(refreshGrant.parse({ ...owner, token: tokens.refresh_token })),
        )
      : request.action === "refresh"
        ? request.refreshToken
        : undefined;

    return {
      accessToken: tokens.access_token,
      refreshToken,
      idToken: tokens.id_token,
      accessTokenExpiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : undefined,
      refreshTokenExpiresAt: tokens.refresh_token_expires_in
        ? new Date(Date.now() + tokens.refresh_token_expires_in * 1000)
        : undefined,
      scopes: tokens.scope?.split(/[ ,]+/).filter(Boolean) ?? provider.scopes,
      tokenType: tokens.token_type ?? "Bearer",
    };
  },

  async callback(request: Request, available: (identity: OAuthIdentity) => Promise<boolean>) {
    const config = configuration(environment);
    const url = new URL(request.url);

    if (!config || url.origin !== config.origin || !url.pathname.startsWith("/oauth/callback/"))
      return null;
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

    if (request.method !== "GET" || url.href.length > 20000)
      return new Response("Invalid OAuth callback", { status: 400, headers });

    try {
      const ticket = z.string().min(1).max(12000).parse(url.searchParams.get("state"));
      const pending = transaction.parse(JSON.parse(await open(environment, "state", ticket)));

      if (
        url.pathname !== callbackPath(pending.provider) ||
        pending.expiresAt <= Date.now() ||
        config.providers[pending.provider]?.clientId !== pending.clientId ||
        !(await available(pending))
      )
        throw new Error("OAuth transaction is not available");
      const issuer = url.searchParams.get("iss");

      if (issuer && !providers[pending.provider].issuer.test(issuer))
        throw new Error("Unexpected OAuth issuer");
      const target = new URL(`/auth/callback/${pending.provider}`, pending.origin);
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
