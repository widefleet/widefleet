import { createHash } from "node:crypto";
import { Request, Response } from "miniflare";
import { z } from "zod";
import { scopes } from "../src/auth.ts";

type Answer = { status: number; body: object | null; headers: Record<string, string> };

type State = {
  refreshes: number;
  unavailable: boolean;
  // The scopes a consent grants; tests narrow them to check reauthorization.
  scope: string;
  // An answer that replaces the next API response.
  answer: Answer | null;
  // What the user decided on their paired phone for each SCA session.
  sessions: Map<string, "waiting" | "allow" | "deny">;
};

const api = "https://thirdparty.qonto.com";

export const allScopes = scopes.join(" ");

// A synthetic Qonto: its OAuth endpoints and the API operations the tests call.
export const provider = () => {
  const codes = new Map<string, { user: string; challenge: string; redirect: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();

  const calls: {
    method: string;
    url: string;
    idempotencyKey?: string | undefined;
    scaSessionToken?: string | undefined;
  }[] = [];

  const state: State = {
    refreshes: 0,
    unavailable: false,
    scope: allScopes,
    answer: null,
    sessions: new Map(),
  };

  // Transfers created, by idempotency key, so a repeated key returns the first transfer.
  const transfers = new Map<string, object>();

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
    transfers,
    authorize: (location: string, user: string) => {
      const url = new URL(location);

      if (url.origin + url.pathname !== "https://oauth.qonto.com/oauth2/auth")
        throw new Error(`Unexpected authorization at ${url.href}`);

      if (url.searchParams.get("client_id") !== "test-qonto-client")
        throw new Error("Unknown client");

      if (url.searchParams.get("scope") !== allScopes) throw new Error("Unexpected scopes");

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

      if (url.href === "https://oauth.qonto.com/oauth2/token") {
        // Qonto reads the client's credentials from the form and rejects Basic authentication.
        if (request.headers.has("authorization"))
          return Response.json({ error: "invalid_client" }, { status: 401 });
        const form = new URLSearchParams(await request.text());

        if (
          form.get("client_id") !== "test-qonto-client" ||
          form.get("client_secret") !== "test-qonto-secret"
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

          // The earlier refresh token stops working.
          if (!user) return Response.json({ error: "invalid_grant" }, { status: 400 });
          refresh.delete(token);

          return tokens(user);
        }
      }

      const path = `${url.origin}${url.pathname}`;

      // SCA sessions need no token: their token identifies them.
      const session = /^https:\/\/thirdparty\.qonto\.com\/v2\/sca_sessions\/([^/]+)$/.exec(path);

      if (session) {
        calls.push({ method: request.method, url: url.href });
        const result = state.sessions.get(decodeURIComponent(session[1] ?? ""));

        if (!result) return Response.json({ errors: [{ code: "not_found" }] }, { status: 404 });

        return Response.json({ result, canceled_at: "" });
      }

      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const user = access.get(token);

      if (!user) return new Response(null, { status: 401 });
      const idempotencyKey = request.headers.get("x-qonto-idempotency-key") ?? undefined;
      const scaSessionToken = request.headers.get("x-qonto-sca-session-token") ?? undefined;
      calls.push({ method: request.method, url: url.href, idempotencyKey, scaSessionToken });

      if (state.answer) {
        const { status, body, headers } = state.answer;
        state.answer = null;

        return body === null
          ? new Response(null, { status, headers })
          : Response.json(body, { status, headers });
      }

      if (path === `${api}/v2/membership`)
        return Response.json({
          membership: {
            id: `membership-${user}`,
            first_name: "Ada",
            last_name: "Test",
            email: `member${user}@example.test`,
            role: "owner",
          },
        });

      if (path === `${api}/v2/transactions`)
        return Response.json({
          transactions: [
            {
              id: "7b7a5ed6-3903-4782-889d-b4f64bd7bef9",
              amount: 12.5,
              side: "debit",
              label: `Coffee for ${user}`,
              status: "completed",
            },
          ],
          meta: { current_page: 1, next_page: null, per_page: 1 },
        });

      if (path === `${api}/v2/clients`)
        return Response.json({ clients: [], meta: { current_page: 1, next_page: null } });

      if (path === `${api}/v2/bank_accounts/account-1/iban_certificate`)
        return new Response("%PDF-1.7 synthetic", {
          headers: { "content-type": "application/pdf" },
        });

      // A transfer to a beneficiary the organization has not trusted asks for
      // approval on the paired phone, unless its approved session is attached.
      if (path === `${api}/v2/sepa/transfers` && request.method === "POST") {
        if (!idempotencyKey)
          return Response.json({ errors: [{ code: "idempotency_key_missing" }] }, { status: 400 });

        const body = z
          .object({ transfer: z.object({ beneficiary_id: z.string(), amount: z.string() }) })
          .parse(await request.json());

        const trusted = body.transfer.beneficiary_id === "trusted-beneficiary";

        if (!trusted && state.sessions.get(scaSessionToken ?? "") !== "allow") {
          const sca = `sca-${crypto.randomUUID()}`;
          state.sessions.set(sca, "waiting");

          return Response.json(
            {
              message: "SCA required",
              code: "sca_required",
              sca_session_token: sca,
              action_type: "create_sepa_transfer",
            },
            { status: 428 },
          );
        }

        const transfer = transfers.get(idempotencyKey) ?? {
          transfer: { id: `transfer-${transfers.size + 1}`, status: "pending", ...body.transfer },
        };

        transfers.set(idempotencyKey, transfer);

        return Response.json(transfer);
      }

      // Revoking ends every token of the member's grant, refresh tokens included.
      if (path === `${api}/v2/oauth2/consents` && request.method === "DELETE") {
        for (const tokens of [access, refresh])
          for (const [key, owner] of tokens) if (owner === user) tokens.delete(key);

        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};
