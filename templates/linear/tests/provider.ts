import { createHash } from "node:crypto";
import { Headers, Request, Response } from "miniflare";
import { z } from "zod";

const kind = "linear";

const graphqlRequest = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.json()).optional(),
});

type Json = z.infer<ReturnType<typeof z.json>>;

// A synthetic Linear OAuth application and GraphQL API. Answers follow the
// operation a request names; `state.errors` replaces them with GraphQL errors.
export const provider = () => {
  const codes = new Map<string, { user: string; challenge: string | null; redirect: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();

  const calls: z.infer<typeof graphqlRequest>[] = [];
  const errors: Json[] = [];

  const state = {
    refreshes: 0,
    unavailable: false,
    apiStatus: 200,
    apiHeaders: new Headers(),
    errors,
  };

  const tokens = (user: string) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    access.set(accessToken, user);
    refresh.set(refreshToken, user);

    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 86399,
      scope: "read",
    });
  };

  return {
    state,
    calls,
    revokeAccess: () => access.clear(),
    authorize: (location: string, user: string) => {
      const url = new URL(location);
      const redirect = z.url().parse(url.searchParams.get("redirect_uri"));
      // Linear makes PKCE optional; Better Auth's Linear provider omits it.
      const challenge = url.searchParams.get("code_challenge");
      const oauthState = z.string().min(1).parse(url.searchParams.get("state"));

      if (challenge && url.searchParams.get("code_challenge_method") !== "S256")
        throw new Error("PKCE requires S256");
      const code = crypto.randomUUID();
      codes.set(code, { user, challenge, redirect });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", oauthState);

      return callback.href;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.href === "https://api.linear.app/oauth/token") {
        const form = new URLSearchParams(await request.text());

        if (
          form.get("client_id") !== `test-${kind}-client` ||
          form.get("client_secret") !== `test-${kind}-secret`
        )
          return Response.json({ error: "invalid_client" }, { status: 400 });

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

          return tokens(saved.user);
        }

        if (form.get("grant_type") === "refresh_token") {
          state.refreshes++;

          if (state.unavailable)
            return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
          const token = form.get("refresh_token") ?? "";
          const user = refresh.get(token);

          if (!user) return Response.json({ error: "invalid_grant" }, { status: 400 });
          refresh.delete(token);

          return tokens(user);
        }
      }

      if (url.href !== "https://api.linear.app/graphql" || request.method !== "POST")
        throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      // Linear reports an unknown token as a GraphQL authentication error.
      if (!user)
        return Response.json(
          {
            errors: [
              { message: "Authentication required", extensions: { type: "authentication error" } },
            ],
          },
          { status: 400 },
        );
      const body = graphqlRequest.parse(await request.json());

      // Better Auth reads the account that authorized the app.
      if (/^\s*query\s*\{\s*viewer\s*\{\s*id\s+name\s+email/.test(body.query))
        return Response.json({
          data: {
            viewer: {
              id: `user-${user}`,
              name: user,
              email: `${user}@example.test`,
              avatarUrl: null,
              active: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          },
        });
      calls.push(body);

      if (state.apiStatus !== 200)
        return new Response(null, { status: state.apiStatus, headers: state.apiHeaders });

      if (state.errors.length)
        return Response.json({ data: null, errors: state.errors }, { headers: state.apiHeaders });

      const field = /\{ (\w+)/.exec(body.query)?.[1];

      if (field === "issues")
        return Response.json({
          data: { issues: { nodes: [{ identifier: "ENG-1", title: "Synthetic issue" }] } },
        });

      if (field === "issueCreate")
        return Response.json({
          data: { issueCreate: { success: true, issue: { identifier: "ENG-2" } } },
        });

      if (field === "issueDelete")
        return Response.json({ data: { issueDelete: { success: true } } });

      return Response.json(
        {
          errors: [
            { message: `Cannot query field "${field}"`, extensions: { type: "graphql error" } },
          ],
        },
        { status: 400 },
      );
    },
  };
};
