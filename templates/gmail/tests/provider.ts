import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Request, Response } from "miniflare";
import { z } from "zod";
import { message } from "../src/messages.ts";

const kind = "google";

const base64url = (value: Uint8Array) =>
  btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encode = (value: string) => base64url(new TextEncoder().encode(value));

export const provider = () => {
  const codes = new Map<
    string,
    {
      user: string;
      challenge: string;
      redirect: string;
      nonce: string | null;
    }
  >();

  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const attachmentReads: string[] = [];

  const state = {
    refreshes: 0,
    unavailable: false,
    apiStatus: 200,
    attachmentReads,
    attachments: new Map([["body", { size: 5, data: "SGVsbG8" }]]),
    message: message.parse({
      id: "message",
      threadId: "thread",
      snippet: "Hello",
      internalDate: "1700000000000",
      payload: {
        partId: "",
        mimeType: "text/plain",
        headers: [],
        body: { size: 5, attachmentId: "body" },
      },
    }),
  };

  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };

  const tokens = (user: string, nonce: string | null = null) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    access.set(accessToken, user);
    refresh.set(refreshToken, user);
    const header = encode(JSON.stringify({ alg: "RS256", kid: jwk.kid }));
    const now = Math.floor(Date.now() / 1000);

    const payload = encode(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: `test-${kind}-client`,
        sub: user,
        iat: now,
        exp: now + 3600,
        name: user,
        email: `${user}@example.test`,
        email_verified: true,
        nonce,
      }),
    );

    const unsigned = `${header}.${payload}`;
    const signature = base64url(sign("RSA-SHA256", unsigned, keys.privateKey));

    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: `${unsigned}.${signature}`,
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid profile email https://www.googleapis.com/auth/gmail.readonly",
    });
  };

  return {
    state,
    authorize: (location: string, user: string) => {
      const url = new URL(location);
      const redirect = z.url().parse(url.searchParams.get("redirect_uri"));
      const challenge = z.string().min(1).parse(url.searchParams.get("code_challenge"));
      const oauthState = z.string().min(1).parse(url.searchParams.get("state"));

      if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("Missing PKCE");
      const code = crypto.randomUUID();
      codes.set(code, { user, challenge, redirect, nonce: url.searchParams.get("nonce") });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", oauthState);

      return callback.href;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.href === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [jwk] });

      if (url.href === "https://oauth2.googleapis.com/token") {
        const form = request.headers.get("content-type")?.includes("application/json")
          ? new URLSearchParams(z.record(z.string(), z.string()).parse(await request.json()))
          : new URLSearchParams(await request.text());

        if (
          form.get("client_id") !== `test-${kind}-client` ||
          form.get("client_secret") !== `test-${kind}-secret`
        )
          return Response.json({ error: "invalid_client" }, { status: 400 });

        if (form.get("grant_type") === "authorization_code") {
          const code = form.get("code") ?? "";
          const saved = codes.get(code);
          codes.delete(code);

          const challenge = createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url");

          if (
            !saved ||
            saved.challenge !== challenge ||
            saved.redirect !== form.get("redirect_uri")
          )
            return Response.json({ error: "invalid_grant" }, { status: 400 });

          return tokens(saved.user, saved.nonce);
        }

        if (form.get("grant_type") === "refresh_token") {
          state.refreshes++;

          if (state.unavailable)
            return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
          const user = refresh.get(form.get("refresh_token") ?? "");

          if (!user) return Response.json({ error: "invalid_grant" }, { status: 400 });

          return tokens(user);
        }
      }

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      if (!user) return new Response(null, { status: 401 });

      if (state.apiStatus !== 200) return new Response(null, { status: state.apiStatus });

      if (url.href.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?"))
        return Response.json({
          messages: [{ id: `message-${user}`, threadId: "thread" }],
          nextPageToken: "next",
        });

      if (url.href.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/message?"))
        return Response.json(state.message);

      if (url.pathname.startsWith("/gmail/v1/users/me/messages/message/attachments/")) {
        const id = url.pathname.split("/").at(-1) ?? "";
        state.attachmentReads.push(id);
        const body = state.attachments.get(id);

        return body ? Response.json(body) : new Response(null, { status: 404 });
      }

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};
