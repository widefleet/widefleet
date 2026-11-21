import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Request, Response } from "miniflare";
import { z } from "zod";

const base64url = (value: Uint8Array) =>
  btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encode = (value: string) => base64url(new TextEncoder().encode(value));

// Synthetic providers check PKCE, callback URI, credentials and one-use codes.
// Linear's MCP authorization server knows the installation by its Client ID
// Metadata Document; Linear OAuth applications use a registered client.
const linearDocument = "https://oauth.example.test:25453/oauth/client-metadata.json";

export const oauthProvider = (kind: "google" | "github" | "microsoft" | "linear") => {
  const codes = new Map<string, { user: string; challenge: string | null; redirect: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const state = { refreshes: 0, exchanges: 0, revocations: 0, unavailable: false, expiring: true };
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };

  const tenant = "9188040d-6c67-4c5b-b112-36a304b66dad";

  const scopes = {
    google: "openid profile email https://www.googleapis.com/auth/gmail.readonly",
    github: "repo read:user user:email",
    microsoft: "openid profile email offline_access User.Read Files.Read",
    linear: "read write",
  };

  const tokenURLs = {
    google: "https://oauth2.googleapis.com/token",
    github: "https://github.com/login/oauth/access_token",
    microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    linear: "https://api.linear.app/oauth/token",
  };

  const linearToken = "https://mcp.linear.app/token";

  const tokens = (user: string) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    access.set(accessToken, user);

    if (!state.expiring)
      return Response.json({
        access_token: accessToken,
        token_type: "Bearer",
        scope: scopes[kind],
      });
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    refresh.set(refreshToken, user);

    const header = encode(JSON.stringify({ alg: "RS256", kid: jwk.kid }));

    const now = Math.floor(Date.now() / 1000);

    const payload = encode(
      JSON.stringify({
        iss:
          kind === "google"
            ? "https://accounts.google.com"
            : `https://login.microsoftonline.com/${tenant}/v2.0`,
        aud: `test-${kind}-client`,
        sub: user,
        oid: user,
        tid: tenant,
        iat: now,
        exp: now + 3600,
        name: user,
        email: `${user}@example.test`,
        email_verified: true,
      }),
    );

    const unsigned = `${header}.${payload}`;

    const signature = base64url(sign("RSA-SHA256", unsigned, keys.privateKey));

    const result = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: "Bearer",
      scope: scopes[kind],
    };

    // Linear's token responses carry no ID token without the openid scope.
    return Response.json(
      kind === "linear" ? result : { ...result, id_token: `${unsigned}.${signature}` },
    );
  };

  return {
    state,
    tokens,
    authorize(location: string, user: string) {
      const url = new URL(location);
      const redirect = z.url().parse(url.searchParams.get("redirect_uri"));

      // Linear OAuth applications make PKCE optional; Better Auth's Linear provider omits it.
      const optional = kind === "linear" && !url.searchParams.has("code_challenge");

      const challenge = optional
        ? null
        : z.string().min(1).parse(url.searchParams.get("code_challenge"));

      const oauthState = z.string().min(1).parse(url.searchParams.get("state"));

      if (!optional && url.searchParams.get("code_challenge_method") !== "S256")
        throw new Error("Missing PKCE");
      const code = crypto.randomUUID();
      codes.set(code, { user, challenge, redirect });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", oauthState);

      return callback.href;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.pathname.endsWith("/certs") || url.pathname.endsWith("/keys"))
        return Response.json({ keys: [jwk] });

      // RFC 7009 revocation, as Google offers it.
      if (url.href === "https://oauth2.googleapis.com/revoke") {
        const form = new URLSearchParams(await request.text());
        const token = form.get("token") ?? "";

        if (
          form.get("client_id") !== `test-${kind}-client` ||
          form.get("client_secret") !== `test-${kind}-secret` ||
          !(refresh.delete(token) || access.delete(token))
        )
          return Response.json({ error: "invalid_token" }, { status: 400 });
        state.revocations++;

        return new Response(null);
      }

      const metadataDocumentClient = kind === "linear" && url.href === linearToken;

      if (url.href === tokenURLs[kind] || metadataDocumentClient) {
        const form = request.headers.get("content-type")?.includes("application/json")
          ? new URLSearchParams(z.record(z.string(), z.string()).parse(await request.json()))
          : new URLSearchParams(await request.text());

        // A public client authenticates by PKCE alone and names its tokens' resource.
        if (
          metadataDocumentClient
            ? form.get("client_id") !== linearDocument ||
              form.has("client_secret") ||
              (form.has("grant_type") && form.get("resource") !== "https://mcp.linear.app/mcp")
            : form.get("client_id") !== `test-${kind}-client` ||
              form.get("client_secret") !== `test-${kind}-secret`
        )
          return Response.json({ error: "invalid_client" }, { status: 400 });

        // Linear revokes at its token endpoint (RFC 7009).
        if (metadataDocumentClient && !form.has("grant_type")) {
          const token = form.get("token") ?? "";

          if (!(refresh.delete(token) || access.delete(token)))
            return Response.json({ error: "invalid_token" }, { status: 400 });
          state.revocations++;

          return new Response(null);
        }

        if (form.get("grant_type") === "authorization_code") {
          const code = form.get("code") ?? "";
          const saved = codes.get(code);
          codes.delete(code);

          const verifier = form.get("code_verifier");

          const challenge =
            verifier === null ? null : createHash("sha256").update(verifier).digest("base64url");

          if (
            !saved ||
            saved.challenge !== challenge ||
            saved.redirect !== form.get("redirect_uri")
          )
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          state.exchanges++;

          return tokens(saved.user);
        }

        if (form.get("grant_type") === "refresh_token") {
          state.refreshes++;

          if (state.unavailable)
            return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
          const user = refresh.get(form.get("refresh_token") ?? "");

          if (!user) return Response.json({ error: "invalid_grant" }, { status: 400 });
          refresh.delete(form.get("refresh_token") ?? "");

          return tokens(user);
        }
      }

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      if (!user) return new Response(null, { status: 401 });

      if (url.href === "https://api.github.com/user")
        return Response.json({
          id: Number(user),
          login: user,
          name: user,
          email: `${user}@example.test`,
        });

      if (url.href === "https://api.github.com/user/emails")
        return Response.json([{ email: `${user}@example.test`, primary: true, verified: true }]);

      if (url.pathname === "/user/repos") return Response.json([]);

      if (url.pathname === "/gmail/v1/users/me/messages") return Response.json({ messages: [] });

      if (url.pathname === "/v1.0/me/drive/root/children") return Response.json({ value: [] });

      if (url.href === "https://mcp.linear.app/mcp") {
        const { name } = z
          .object({ params: z.object({ name: z.string() }) })
          .parse(await request.json()).params;

        const output =
          name === "get_user"
            ? { id: user, name: user, email: `${user}@example.test` }
            : { issues: [], hasNextPage: false };

        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(output) }] } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }

      throw new Error(`Unexpected request: ${url.origin}${url.pathname}`);
    },
  };
};
