import { createHash } from "node:crypto";
import { Request, Response } from "miniflare";

export const provider = () => {
  const codes = new Map<string, { user: string; challenge: string; redirect: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const state = { refreshes: 0, revoked: false, unavailable: false, apiStatus: 200 };

  const scopes = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
  ];

  const tokens = (user: string) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    access.set(accessToken, user);
    refresh.set(refreshToken, user);

    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: "Bearer",
      scope: scopes.join(" "),
    });
  };

  return {
    state,
    authorize: (location: string, user: string) => {
      const url = new URL(location);
      const redirect = url.searchParams.get("redirect_uri");
      const challenge = url.searchParams.get("code_challenge");
      const oauthState = url.searchParams.get("state");

      if (
        url.origin !== "https://accounts.google.com" ||
        !redirect ||
        !challenge ||
        !oauthState ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        url.searchParams.get("access_type") !== "offline" ||
        !url.searchParams.get("prompt")?.includes("consent") ||
        !scopes.every((scope) => url.searchParams.get("scope")?.split(" ").includes(scope))
      )
        throw new Error("Unexpected authorization request");

      const code = crypto.randomUUID();
      codes.set(code, { user, challenge, redirect });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", oauthState);

      return callback.href;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.href === "https://oauth2.googleapis.com/token") {
        const form = new URLSearchParams(await request.text());

        if (
          form.get("client_id") !== "test-google-client" ||
          form.get("client_secret") !== "test-google-secret"
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

          return tokens(saved.user);
        }

        if (form.get("grant_type") === "refresh_token") {
          state.refreshes++;

          if (state.unavailable)
            return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
          const user = refresh.get(form.get("refresh_token") ?? "");

          if (state.revoked || !user)
            return Response.json({ error: "invalid_grant" }, { status: 400 });

          return tokens(user);
        }
      }

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      if (!user) return new Response(null, { status: 401 });

      if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo")
        return Response.json({
          sub: user,
          name: user,
          email: `${user}@example.test`,
          email_verified: true,
        });

      if (url.origin === "https://gmail.googleapis.com") {
        if (state.apiStatus !== 200) return new Response(null, { status: state.apiStatus });

        if (url.pathname === "/gmail/v1/users/me/messages") {
          if (
            url.searchParams.get("maxResults") !== "5" ||
            url.searchParams.get("pageToken") !== "next-page"
          )
            throw new Error("Gmail pagination was not forwarded");

          return Response.json({
            messages: [{ id: `message-${user}`, threadId: "thread-1" }],
            nextPageToken: "page-2",
          });
        }

        if (
          url.pathname === "/gmail/v1/users/me/messages/abc123" &&
          url.searchParams.get("format") === "metadata"
        )
          return Response.json({
            id: "abc123",
            threadId: "thread-1",
            snippet: "Synthetic message",
            payload: { headers: [{ name: "Subject", value: `Hello ${user}` }] },
          });
      }

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};
