// A loopback-only provider inside the disposable SSO container. Never shipped in an image.
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";

const tlsDirectory = process.env["OIDC_TLS_DIRECTORY"];

const issuer = tlsDirectory ? "https://localhost:4181" : "http://127.0.0.1:4181";

const keys = await generateKeyPair("RS256", { extractable: true });

const publicKey = {
  ...(await exportJWK(keys.publicKey)),
  kid: "rotation",
  alg: "RS256",
  use: "sig",
};

const authorization = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  state: z.string(),
  nonce: z.string(),
  code_challenge: z.string(),
});

const codes = new Map<string, z.infer<typeof authorization>>();

let acceptedSecret = "test-secret";

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
        code_challenge_methods_supported: ["S256"],
      }),
    );
  } else if (url.pathname === "/jwks") {
    response.end(JSON.stringify({ keys: [publicKey] }));
  } else if (url.pathname === "/authorize") {
    const parameters = authorization.parse(Object.fromEntries(url.searchParams));
    const code = randomUUID();
    codes.set(code, parameters);
    const callback = new URL(parameters.redirect_uri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", parameters.state);
    response.writeHead(302, { location: callback.href }).end();
  } else if (request.method === "POST") {
    const chunks: Buffer[] = [];

    for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
    const body = Buffer.concat(chunks).toString("utf8");

    if (url.pathname === "/rotate") {
      acceptedSecret = body;
      response.writeHead(204).end();

      return;
    }

    const fields = new URLSearchParams(body);
    const basic = request.headers.authorization;

    const secret = basic?.startsWith("Basic ")
      ? Buffer.from(basic.slice(6), "base64").toString("utf8").split(":")[1]
      : fields.get("client_secret");

    if (secret !== acceptedSecret) {
      response.writeHead(401).end(JSON.stringify({ error: "invalid_client" }));

      return;
    }

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

    const token = await new SignJWT({
      nonce: parameters.nonce,
      email: "rotation@example.test",
      email_verified: true,
      name: "Rotation Test",
    })
      .setProtectedHeader({ alg: "RS256", kid: "rotation" })
      .setIssuer(issuer)
      .setAudience(parameters.client_id)
      .setSubject("rotation-user")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keys.privateKey);

    response.end(
      JSON.stringify({
        access_token: "fixture-only",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: token,
      }),
    );
  } else response.end("{}");
};

const listener = (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
) => {
  void handle(request, response).catch(() => response.writeHead(500).end());
};

const server = tlsDirectory
  ? createSecureServer(
      {
        key: await readFile(join(tlsDirectory, "server.key")),
        cert: await readFile(join(tlsDirectory, "server.pem")),
      },
      listener,
    )
  : createServer(listener);

server.listen(4181, "127.0.0.1");
