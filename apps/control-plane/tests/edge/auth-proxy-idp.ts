import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { z } from "zod";

const authorization = z.object({
  client_id: z.literal("app-login"),
  redirect_uri: z.url(),
  state: z.string().min(1),
  nonce: z.string().min(1).optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal("S256"),
});

export const tenantId = "00000000-0000-4000-8000-000000000001";

export const objectId = "00000000-0000-4000-8000-000000000002";

export const createIdentityProvider = async (
  redirectUrl: string | string[] = "https://auth.apps.example.test/oauth2/widefleet/callback",
  requireNonce = true,
) => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const wrongKeys = await generateKeyPair("RS256");
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const codes = new Map<string, z.infer<typeof authorization>>();
  const refreshes = new Map<string, z.infer<typeof authorization>>();
  const replays = new Map<string, { response: string; expiresAt: number }>();
  let queue = Promise.resolve();

  const settings = {
    available: true,
    failure: "",
    entra: false,
    groups: ["accounting"],
    name: "Example User",
    email: "user@example.test",
    graphFailure: "",
    issuerSuffix: "",
    refreshFailure: "",
    rotateRefreshTokens: false,
    issueRefreshToken: true,
    omitRefreshIdToken: false,
    subject: "pairwise-subject",
  };

  const graphRequests: string[] = [];
  const tokenOrigins: (string | undefined)[] = [];
  const refreshRequests: string[] = [];

  const server = createServer((request, response) => {
    const handle = async () => {
      const url = new URL(request.url ?? "/", origin);
      const issuer = settings.entra ? `${origin}/${tenantId}/v2.0` : origin + settings.issuerSuffix;

      response.setHeader("content-type", "application/json");

      if (!settings.available) {
        response.writeHead(503).end();

        return;
      }

      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            jwks_uri: `${origin}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
      } else if (url.pathname === "/jwks") {
        response.end(JSON.stringify({ keys: [publicKey] }));
      } else if (url.pathname === "/authorize") {
        const parameters = authorization.parse(Object.fromEntries(url.searchParams));

        if (requireNonce && !parameters.nonce) throw new Error("Missing OIDC nonce");

        if (
          !(Array.isArray(redirectUrl) ? redirectUrl : [redirectUrl]).includes(
            parameters.redirect_uri,
          )
        )
          throw new Error("Unexpected callback URL");
        const code = randomUUID();

        codes.set(code, parameters);
        const target = new URL(parameters.redirect_uri);

        target.searchParams.set("state", parameters.state);
        target.searchParams.set("code", code);
        response.writeHead(302, { location: target.href }).end();
      } else if (url.pathname === "/token" && request.method === "POST") {
        tokenOrigins.push(request.headers.origin);

        // Entra rejects confidential-client token exchanges carrying a browser Origin.
        if (settings.entra && request.headers.origin !== undefined) {
          response.writeHead(400).end(JSON.stringify({ error: "invalid_request" }));

          return;
        }

        const chunks: Buffer[] = [];

        for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
        const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const refreshing = fields.get("grant_type") === "refresh_token";
        const credential = fields.get("refresh_token") ?? "";

        const parameters = refreshing
          ? refreshes.get(credential)
          : codes.get(fields.get("code") ?? "");

        if (refreshing) {
          refreshRequests.push(credential);

          const replay = settings.rotateRefreshTokens ? replays.get(credential) : undefined;

          if (
            replay &&
            fields.get("client_id") === "app-login" &&
            fields.get("client_secret") === "synthetic-client-secret"
          ) {
            if (replay.expiresAt > Date.now()) response.end(replay.response);
            else response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));

            return;
          }

          if (settings.refreshFailure) {
            response
              .writeHead(
                settings.refreshFailure === "invalid_grant"
                  ? 400
                  : settings.refreshFailure === "access_denied"
                    ? 403
                    : 503,
              )
              .end(JSON.stringify({ error: settings.refreshFailure }));

            return;
          }
        }

        codes.delete(fields.get("code") ?? "");

        if (
          !parameters ||
          fields.get("client_id") !== "app-login" ||
          fields.get("client_secret") !== "synthetic-client-secret" ||
          (!refreshing &&
            (fields.get("redirect_uri") !== parameters.redirect_uri ||
              createHash("sha256")
                .update(fields.get("code_verifier") ?? "")
                .digest("base64url") !== parameters.code_challenge))
        ) {
          response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));

          return;
        }

        const claims = new SignJWT({
          nonce: settings.failure === "nonce" ? "wrong-nonce" : parameters.nonce,
          email_verified: settings.failure !== "email",
          ...(settings.entra
            ? {
                oid: objectId,
                tid: settings.failure === "tenant" ? objectId : tenantId,
                name: settings.name,
                email: settings.email,
                _claim_names: { groups: "src1" },
                _claim_sources: { src1: { endpoint: "https://untrusted.example.test/groups" } },
              }
            : {
                display_name: settings.name,
                mail: settings.email,
                name: settings.name,
                email: settings.email,
                roles: settings.groups,
              }),
        })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer(
            settings.failure === "issuer"
              ? "https://foreign.example.test"
              : settings.failure === "issuer-slash"
                ? issuer.endsWith("/")
                  ? issuer.slice(0, -1)
                  : `${issuer}/`
                : issuer,
          )
          .setAudience(settings.failure === "audience" ? "other-app" : "app-login")
          .setSubject(settings.subject);

        if (settings.failure !== "missing-issued-at") claims.setIssuedAt();

        if (settings.failure !== "missing-expiry")
          claims.setExpirationTime(settings.failure === "expired" ? "-1h" : "1h");

        const token = await claims.sign(
          settings.failure === "signature" ? wrongKeys.privateKey : keys.privateKey,
        );

        const refreshToken = randomUUID();
        refreshes.set(refreshToken, parameters);

        const result = JSON.stringify({
          access_token: "fixture-access-token",
          refresh_token: settings.issueRefreshToken ? refreshToken : undefined,
          token_type: "Bearer",
          expires_in: 3600,
          id_token:
            settings.failure === "missing-token" || (refreshing && settings.omitRefreshIdToken)
              ? undefined
              : token,
        });

        if (refreshing && settings.rotateRefreshTokens) {
          refreshes.delete(credential);
          replays.set(credential, { response: result, expiresAt: Date.now() + 30_000 });
        }

        response.end(result);
      } else if (url.pathname === "/v1.0/me/transitiveMemberOf") {
        graphRequests.push(url.href);

        if (settings.graphFailure === "throttled") {
          response.writeHead(429, { "Retry-After": "5" }).end();

          return;
        }

        if (
          request.headers.authorization !== "Bearer fixture-access-token" ||
          settings.graphFailure === "unavailable"
        ) {
          response.writeHead(403).end();

          return;
        }

        const page = Number(url.searchParams.get("page") ?? "0");

        const next =
          settings.graphFailure === "redirect"
            ? "https://untrusted.example.test/v1.0/me/transitiveMemberOf"
            : `https://graph.microsoft.com/v1.0/me/transitiveMemberOf?page=${page + 1}`;

        response.end(
          JSON.stringify({
            value: settings.groups.slice(page * 100, (page + 1) * 100).map((id) => ({ id })),
            "@odata.nextLink": settings.groups.length > (page + 1) * 100 ? next : undefined,
          }),
        );
      } else response.writeHead(404).end();
    };

    queue = queue.then(handle).catch(() => {
      response.writeHead(500).end();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;

  return {
    origin,
    settings,
    graphRequests,
    tokenOrigins,
    refreshRequests,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
