import {
  EncryptJWT,
  base64url,
  createRemoteJWKSet,
  errors,
  jwtDecrypt,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import { cookiePrefix } from "./authentication.ts";
import { sessionVersion, type AuthConfiguration } from "./configuration.ts";
import { graphGroups, issuer, proxyIdentity } from "./identity.ts";

// A page embedding apps proves the user's identity with a token from its own host,
// such as Microsoft Teams. The resulting session is partitioned by the top-level
// site, so it is only sent inside that host and never replaces the regular sign-in.

export const embeddedSessionCookie = (configuration: AuthConfiguration) =>
  `__Secure-${cookiePrefix(configuration)}.embedded_session`;

export const embeddedPath = (organizationId: string) => `/oauth2/${organizationId}/embedded`;

// Node runs the control plane's tools in strip-only mode, so no parameter properties.
export class EmbeddedSignInFailure extends Error {
  readonly status: 401 | 403 | 503;

  readonly code: "invalid_token" | "consent_required" | "temporarily_unavailable";

  readonly retryAfter: string | undefined;

  constructor(
    status: EmbeddedSignInFailure["status"],
    code: EmbeddedSignInFailure["code"],
    retryAfter?: string,
  ) {
    super(`Embedded sign-in failed: ${code}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const keySets = new Map<string, JWTVerifyGetKey>();

// jose caches keys and refreshes them on an unknown key ID. Only the tenant's
// configured authority is used, so the map stays bounded by published tenants.
const signingKeys = (url: string) => {
  let keys = keySets.get(url);

  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), { timeoutDuration: 10_000 });
    keySets.set(url, keys);
  }

  return keys;
};

const entraHostToken = z.object({
  ver: z.literal("2.0"),
  tid: z.uuid(),
  oid: z.uuid(),
  // Delegated tokens carry scopes; app-only tokens carry roles instead.
  scp: z.string().min(1),
  idtyp: z.literal("user").optional(),
  exp: z.number(),
});

const tokenError = z.object({
  error: z.string(),
  suberror: z.string().optional(),
  error_codes: z.array(z.number()).optional(),
});

const graphProfile = z.object({
  id: z.uuid(),
  displayName: z.string().nullish(),
  mail: z.string().nullish(),
});

// The token's audience is the client that also signs users in to apps, so it
// authenticates the same person a regular company sign-in would.
const entraIdentity = async (configuration: AuthConfiguration, token: string) => {
  const provider = configuration.provider;

  if (provider.type !== "entra") throw new EmbeddedSignInFailure(401, "invalid_token");

  let claims: z.infer<typeof entraHostToken>;

  try {
    const { payload } = await jwtVerify(
      token,
      signingKeys(`${provider.authority}/${provider.tenantId}/discovery/v2.0/keys`),
      {
        algorithms: ["RS256"],
        issuer: issuer(provider),
        audience: configuration.clientId,
        requiredClaims: ["exp", "iat"],
      },
    );

    claims = entraHostToken.parse(payload);
  } catch (cause) {
    // An unreachable key set is an outage; any other failure rejects the token.
    if (
      cause instanceof errors.JWKSTimeout ||
      (!(cause instanceof errors.JOSEError) && !(cause instanceof z.ZodError))
    )
      throw new EmbeddedSignInFailure(503, "temporarily_unavailable");

    throw new EmbeddedSignInFailure(401, "invalid_token");
  }

  if (claims.tid !== provider.tenantId) throw new EmbeddedSignInFailure(401, "invalid_token");

  // A session must outlive the redirect back to the app.
  if (claims.exp * 1000 - Date.now() < 60_000)
    throw new EmbeddedSignInFailure(401, "invalid_token");

  const exchanged = await fetch(`${provider.authority}/${provider.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      assertion: token,
      scope: "https://graph.microsoft.com/User.Read",
      requested_token_use: "on_behalf_of",
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });

  if (!exchanged.ok) {
    const failure = tokenError.safeParse(await exchanged.json().catch(() => null));

    console.error("Embedded sign-in failed", {
      stage: "exchange",
      status: exchanged.status,
      error: failure.success ? failure.data.error : undefined,
      codes: failure.success ? failure.data.error_codes : undefined,
    });

    if (
      failure.success &&
      (failure.data.error === "interaction_required" ||
        failure.data.error === "consent_required" ||
        failure.data.suberror === "consent_required" ||
        failure.data.error_codes?.includes(65_001))
    )
      throw new EmbeddedSignInFailure(403, "consent_required");

    if (exchanged.status === 429 || exchanged.status >= 500)
      throw new EmbeddedSignInFailure(
        503,
        "temporarily_unavailable",
        exchanged.headers.get("retry-after") ?? undefined,
      );

    throw new EmbeddedSignInFailure(401, "invalid_token");
  }

  const accessToken = z
    .object({ access_token: z.string().min(1) })
    .parse(await exchanged.json()).access_token;

  const profileResponse = await fetch(
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail",
    {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!profileResponse.ok) throw new EmbeddedSignInFailure(503, "temporarily_unavailable");
  const profile = graphProfile.parse(await profileResponse.json());

  if (profile.id !== claims.oid) throw new EmbeddedSignInFailure(401, "invalid_token");

  let groups: string[];

  try {
    groups = await graphGroups(accessToken);
  } catch {
    throw new EmbeddedSignInFailure(503, "temporarily_unavailable");
  }

  // Regular Entra sign-in uses the same object ID, so apps see one caller.
  const identity = proxyIdentity.safeParse({
    id: claims.oid,
    name: profile.displayName ?? "",
    email: profile.mail,
    groups,
  });

  if (!identity.success) throw new EmbeddedSignInFailure(401, "invalid_token");

  return { identity: identity.data, expiresAt: claims.exp * 1000 };
};

const sessionKey = async (configuration: AuthConfiguration) => {
  const secret = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(base64url.decode(configuration.cookieSecret)),
    "HKDF",
    false,
    ["deriveBits"],
  );

  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode("widefleet embedded app session"),
      },
      secret,
      256,
    ),
  );
};

const embeddedSession = z.object({
  identity: proxyIdentity,
  version: z.string(),
});

const cookieAttributes = (configuration: AuthConfiguration, maxAge: number) =>
  `Domain=${configuration.domain}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=None; Partitioned`;

export const clearEmbeddedSession = (configuration: AuthConfiguration) =>
  `${embeddedSessionCookie(configuration)}=; ${cookieAttributes(configuration, 0)}`;

export const signInEmbedded = async (configuration: AuthConfiguration, token: string) => {
  const { identity, expiresAt } = await entraIdentity(configuration, token);
  const callback = new URL(configuration.redirectUrl);

  const value = await new EncryptJWT({
    identity,
    version: await sessionVersion(configuration),
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(callback.origin)
    .setAudience(configuration.organizationId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .encrypt(await sessionKey(configuration));

  return `${embeddedSessionCookie(configuration)}=${value}; ${cookieAttributes(
    configuration,
    Math.floor((expiresAt - Date.now()) / 1000),
  )}`;
};

const cookieValue = (headers: Headers, name: string) => {
  const values = (headers.get("cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(`${name}=`));

  return values.length === 1 ? values[0]?.slice(name.length + 1) : undefined;
};

export const embeddedIdentity = async (configuration: AuthConfiguration, headers: Headers) => {
  const value = cookieValue(headers, embeddedSessionCookie(configuration));

  if (!value) return null;

  try {
    const { payload } = await jwtDecrypt(value, await sessionKey(configuration), {
      issuer: new URL(configuration.redirectUrl).origin,
      audience: configuration.organizationId,
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });

    const session = embeddedSession.parse(payload);

    // Changing the identity provider or client invalidates embedded sessions too.
    return session.version === (await sessionVersion(configuration)) ? session.identity : null;
  } catch {
    return null;
  }
};

const script = (input: { target: string; origins: string[]; endpoint: string; check: string }) => `
const config = ${JSON.stringify(input).replaceAll("<", "\\u003c")};
const status = document.getElementById("status");
const open = document.getElementById("open");
const messages = {
  consent_required: "An administrator must approve this app for your organization.",
  unsupported: "This browser blocks sign-in inside embedded pages. Open the app in a new tab.",
};
const fail = (code) => {
  status.textContent = messages[code] ?? "Sign-in failed. Open the app in a new tab.";
  open.hidden = false;
};
const allowed = (origin) =>
  config.origins.some((pattern) => {
    if (pattern === origin) return true;
    if (!pattern.startsWith("https://*.")) return false;
    const suffix = pattern.slice("https://*".length);
    const host = origin.startsWith("https://") ? origin.slice(8, origin.length - suffix.length) : "";
    return origin.endsWith(suffix) && /^[a-z0-9-]+(?:\\.[a-z0-9-]+)*$/.test(host);
  });
if (window.parent === window) fail();
else {
  let done = false;
  const timeout = setTimeout(() => { done = true; fail(); }, 15000);
  addEventListener("message", async (event) => {
    const data = event.data;
    if (done || event.source !== window.parent || !allowed(event.origin)) return;
    if (!data || data.type !== "widefleet:host-token" || data.version !== 1) return;
    done = true;
    clearTimeout(timeout);
    if (typeof data.token !== "string") return fail(data.error);
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: data.token }),
        credentials: "same-origin",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        return fail(body.error);
      }
      const check = await fetch(config.check, { credentials: "same-origin" });
      if (!check.ok) return fail("unsupported");
      location.replace(config.target);
    } catch {
      fail();
    }
  });
  window.parent.postMessage({ type: "widefleet:host-token-request", version: 1 }, "*");
}
`;

export const embeddedPage = (configuration: AuthConfiguration, target: URL) => {
  const nonce = base64url.encode(crypto.getRandomValues(new Uint8Array(16)));
  const path = embeddedPath(configuration.organizationId);
  const origins = configuration.embeddingOrigins ?? [];

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signing in</title>
<style nonce="${nonce}">
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; color: #18181b; background: #fff; }
main { max-width: 28rem; padding: 1.5rem; text-align: center; }
a { color: inherit; font-weight: 600; }
@media (prefers-color-scheme: dark) { body { color: #fafafa; background: #09090b; } }
</style>
</head>
<body>
<main>
<p id="status" role="status">Signing in…</p>
<p id="open" hidden><a href="${target.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" target="_blank" rel="noopener">Open the app in a new tab</a></p>
</main>
<script nonce="${nonce}">${script({
    target: target.href,
    origins,
    endpoint: path,
    check: `${path}/session`,
  })}</script>
</body>
</html>`;

  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors ${origins.join(" ")}`,
      ].join("; "),
    },
  });
};
