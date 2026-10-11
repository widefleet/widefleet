// Disposable local OIDC provider and echo backend. Never included in the server build.
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createSecureServer } from "node:https";
import { createServer } from "node:http";
import { z } from "zod";

interface GraphPage {
  value: { id: string }[];
  "@odata.nextLink"?: string;
}

const generic = process.env["GENERIC_OIDC"] === "1";

const issuer = generic ? "https://oidc.localhost:25434" : "http://oidc.localhost:25433";

const tokenIssuer = generic
  ? issuer
  : "https://login.microsoftonline.com/00000000-0000-4000-8000-000000000001/v2.0";

const clientId = "00000000-0000-4000-8000-000000000002";

const key = await generateKeyPair("RS256", { extractable: true });

const publicKey = { ...(await exportJWK(key.publicKey)), kid: "fixture", alg: "RS256", use: "sig" };

const authorization = z.object({
  client_id: z.literal(clientId),
  redirect_uri: z.literal("https://auth.apps.localhost:25443/oauth2/callback"),
  state: z.string().min(1),
  nonce: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal("S256"),
});

const codes = new Map<string, z.infer<typeof authorization>>();

const handle = async (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
) => {
  const url = new URL(request.url ?? "/", issuer);

  response.setHeader("content-type", "application/json");

  if (url.pathname === "/.well-known/openid-configuration") {
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      }),
    );
  } else if (url.pathname === "/jwks") {
    response.end(JSON.stringify({ keys: [publicKey] }));
  } else if (url.pathname === "/authorize") {
    const parameters = authorization.parse(Object.fromEntries(url.searchParams));
    const code = randomUUID();
    codes.set(code, parameters);
    const redirect = new URL(parameters.redirect_uri);
    redirect.searchParams.set("state", parameters.state);
    redirect.searchParams.set("code", code);
    response.writeHead(302, { location: redirect.href }).end();
  } else if (url.pathname === "/token" && request.method === "POST") {
    const chunks: Buffer[] = [];

    for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
    const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const code = fields.get("code") ?? "";
    const parameters = codes.get(code);
    codes.delete(code);

    if (
      !parameters ||
      createHash("sha256")
        .update(fields.get("code_verifier") ?? "")
        .digest("base64url") !== parameters.code_challenge
    ) {
      response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));

      return;
    }

    const idToken = await new SignJWT({
      nonce: parameters.nonce,
      oid: "00000000-0000-4000-8000-000000000004",
      email_verified: true,
      ...(generic
        ? { display_name: "SSO Test User", mail: "sso@example.test", roles: ["test-group"] }
        : { name: "SSO Test User", email: "sso@example.test" }),
      ...(process.env["GROUP_OVERAGE"] === "1"
        ? {
            _claim_names: { groups: "src1" },
            _claim_sources: { src1: { endpoint: "https://graph.windows.net/unused" } },
          }
        : { groups: ["test-group"] }),
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(tokenIssuer)
      .setAudience(clientId)
      .setSubject("pairwise-test-subject")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key.privateKey);

    response.end(
      JSON.stringify({
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: idToken,
      }),
    );
  } else {
    response.setHeader("set-cookie", "app_cookie=must-not-be-forwarded; Path=/; Secure; HttpOnly");
    response.end(
      JSON.stringify({ method: request.method, headers: request.headers, url: request.url }),
    );
  }
};

createServer({ maxHeaderSize: 512 * 1024 }, (request, response) => {
  void handle(request, response).catch((error: Error) => {
    console.error(error.message);
    response.writeHead(500).end("Fixture failed");
  });
}).listen(25433, "0.0.0.0");

if (process.env["GROUP_OVERAGE"] === "1") {
  createSecureServer(
    { key: readFileSync("/fixture/server.key"), cert: readFileSync("/fixture/server.pem") },
    (request, response) => {
      const url = new URL(request.url ?? "/", "https://graph.microsoft.com");

      if (
        request.headers.authorization !== "Bearer fixture-access-token" ||
        url.pathname !== "/v1.0/me/transitiveMemberOf"
      ) {
        response.writeHead(403).end();

        return;
      }

      const page = Number(url.searchParams.get("page") ?? "0");

      const groups = Array.from({ length: 1000 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      }));

      response.setHeader("content-type", "application/json");

      const result: GraphPage = {
        value: groups.slice(page * 100, (page + 1) * 100),
      };

      if ((page + 1) * 100 < groups.length)
        result["@odata.nextLink"] =
          `https://graph.microsoft.com/v1.0/me/transitiveMemberOf?page=${page + 1}`;
      response.end(JSON.stringify(result));
    },
  ).listen(443, "0.0.0.0");
}

if (generic) {
  createSecureServer(
    { key: readFileSync("/fixture/server.key"), cert: readFileSync("/fixture/server.pem") },
    (request, response) => {
      void handle(request, response).catch(() => {
        response.writeHead(500).end();
      });
    },
  ).listen(25434, "0.0.0.0");
}
