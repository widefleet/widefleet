import { createHash } from "node:crypto";
import { Request, Response } from "miniflare";
import { z } from "zod";

type Answer = { status: number; body: object | null; headers: Record<string, string> };

type State = {
  refreshes: number;
  unavailable: boolean;
  // The scopes a consent grants; tests narrow them to check reauthorization.
  scope: string;
  // An answer that replaces the next API response.
  answer: Answer | null;
};

const api = "https://api.prod.whoop.com/developer";

const cycle = (id: number) => ({
  id,
  user_id: 0,
  start: "2026-11-22T06:00:00.000Z",
  score_state: "SCORED",
  score: { strain: 12.3, kilojoule: 9000, average_heart_rate: 62, max_heart_rate: 171 },
});

// A synthetic WHOOP: its OAuth endpoints and the API operations the tests call.
export const provider = () => {
  const codes = new Map<string, { user: string; challenge: string; redirect: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const calls: { method: string; url: string }[] = [];

  const state: State = {
    refreshes: 0,
    unavailable: false,
    scope:
      "offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout",
    answer: null,
  };

  const tokens = (user: string) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    access.set(accessToken, user);
    refresh.set(refreshToken, user);

    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: "bearer",
      scope: state.scope,
    });
  };

  return {
    state,
    calls,
    authorize: (location: string, user: string) => {
      const url = new URL(location);

      if (url.origin + url.pathname !== "https://api.prod.whoop.com/oauth/oauth2/auth")
        throw new Error(`Unexpected authorization at ${url.href}`);

      if (url.searchParams.get("client_id") !== "test-whoop-client")
        throw new Error("Unknown client");

      if (
        url.searchParams.get("scope") !==
        "offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout"
      )
        throw new Error("Unexpected scopes");

      // WHOOP requires a state of at least eight characters.
      const oauthState = z.string().min(8).parse(url.searchParams.get("state"));
      const redirect = z.url().parse(url.searchParams.get("redirect_uri"));
      const challenge = z.string().min(1).parse(url.searchParams.get("code_challenge"));

      if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("Missing PKCE");
      const code = crypto.randomUUID();
      codes.set(code, { user, challenge, redirect });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("scope", state.scope);
      callback.searchParams.set("state", oauthState);

      return callback.href;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.href === "https://api.prod.whoop.com/oauth/oauth2/token") {
        const form = new URLSearchParams(await request.text());

        if (
          form.get("client_id") !== "test-whoop-client" ||
          form.get("client_secret") !== "test-whoop-secret"
        )
          return Response.json({ error: "invalid_client" }, { status: 401 });

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
          const token = form.get("refresh_token") ?? "";
          const user = refresh.get(token);

          // WHOOP's refresh names the offline scope, and the earlier refresh token stops working.
          if (!user || form.get("scope") !== "offline")
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          refresh.delete(token);

          return tokens(user);
        }
      }

      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const user = access.get(token);

      if (!user) return new Response(null, { status: 401 });
      calls.push({ method: request.method, url: url.href });

      if (state.answer) {
        const { status, body, headers } = state.answer;
        state.answer = null;

        return body === null
          ? new Response(null, { status, headers })
          : Response.json(body, { status, headers });
      }

      const path = `${url.origin}${url.pathname}`;

      if (path === `${api}/v2/user/profile/basic`)
        return Response.json({
          user_id: Number(user),
          email: `member${user}@example.test`,
          first_name: "Ada",
          last_name: "Test",
        });

      if (path === `${api}/v2/cycle`)
        return Response.json(
          url.searchParams.get("nextToken") === "page-2"
            ? { records: [cycle(93844)] }
            : { records: [{ ...cycle(93845), user_id: Number(user) }], next_token: "page-2" },
        );

      if (path === `${api}/v2/cycle/93845/recovery`)
        return Response.json({
          cycle_id: 93845,
          sleep_id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
          user_id: Number(user),
          score_state: "SCORED",
          score: { recovery_score: 44, resting_heart_rate: 64, hrv_rmssd_milli: 31.8 },
        });

      // Revoking ends every token of the member's grant.
      if (path === `${api}/v2/user/access` && request.method === "DELETE") {
        for (const [key, owner] of access) if (owner === user) access.delete(key);

        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};
