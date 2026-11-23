import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Request, Response } from "miniflare";
import { z } from "zod";

const kind = "microsoft";

const base64url = (value: Uint8Array) =>
  btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encode = (value: string) => base64url(new TextEncoder().encode(value));

type Answer = { status: number; body: object | null; headers: Record<string, string> };

type State = {
  refreshes: number;
  unavailable: boolean;
  // The scopes a consent grants; tests narrow them to check reauthorization.
  scope: string;
  // An answer that replaces the next Graph response.
  answer: Answer | null;
};

const graph = "https://graph.microsoft.com/v1.0";

const message = (id: string, subject: string) => ({
  id,
  subject,
  from: { emailAddress: { address: "alice@example.test" } },
});

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
  const calls: { method: string; url: string; body: string | null; type: string | null }[] = [];

  const state: State = {
    refreshes: 0,
    unavailable: false,
    scope:
      "openid profile email offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite MailboxSettings.ReadWrite",
    answer: null,
  };

  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };

  const tenant = "9188040d-6c67-4c5b-b112-36a304b66dad";

  const tokens = (user: string, nonce: string | null = null) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    access.set(accessToken, user);
    refresh.set(refreshToken, user);
    const header = encode(JSON.stringify({ alg: "RS256", kid: jwk.kid }));
    const now = Math.floor(Date.now() / 1000);

    const payload = encode(
      JSON.stringify({
        iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
        aud: `test-${kind}-client`,
        sub: user,
        oid: user,
        tid: tenant,
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
      scope: state.scope,
    });
  };

  return {
    state,
    calls,
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

      if (url.href === "https://login.microsoftonline.com/common/discovery/v2.0/keys")
        return Response.json({ keys: [jwk] });

      if (url.href === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
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

      calls.push({
        method: request.method,
        url: url.href,
        body: (await request.text()) || null,
        type: request.headers.get("content-type"),
      });

      if (state.answer) {
        const { status, body, headers } = state.answer;
        state.answer = null;

        return body === null
          ? new Response(null, { status, headers })
          : Response.json(body, { status, headers });
      }

      const path = `${url.origin}${url.pathname}`;

      if (path === `${graph}/me/messages` && request.method === "GET")
        return Response.json(
          url.searchParams.has("$skiptoken")
            ? { value: [message("message-2", "Second")] }
            : {
                value: [message(`message-${user}`, "Hello")],
                "@odata.nextLink": `${graph}/me/messages?$skiptoken=page-2`,
              },
        );

      if (path === `${graph}/me/messages` && request.method === "POST")
        return Response.json(message("draft-1", "Draft"), { status: 201 });

      if (path === `${graph}/me/messages/message-1/$value` && request.method === "GET")
        return new Response("Subject: Hello\r\n\r\nHi", {
          headers: { "content-type": "text/plain" },
        });

      if (path === `${graph}/me/sendMail` && request.method === "POST")
        return new Response(null, { status: 202 });

      if (path === `${graph}/me/calendar/getSchedule` && request.method === "POST")
        return Response.json({
          value: [{ scheduleId: "bob@example.test", availabilityView: "000" }],
        });

      if (path === `${graph}/me/messages/message-1` && request.method === "DELETE")
        return new Response(null, { status: 204 });

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};
