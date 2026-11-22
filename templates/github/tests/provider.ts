import { createHash } from "node:crypto";
import { Headers, Request, Response } from "miniflare";
import { z } from "zod";

const kind = "github";

const graphqlRequest = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.json()).optional(),
});

type Json = z.infer<ReturnType<typeof z.json>>;

// A synthetic GitHub OAuth app and GraphQL API. Answers follow the operation a
// request names; `state.errors` replaces them with GraphQL errors.
export const provider = () => {
  const codes = new Map<string, { user: string; challenge: string; redirect: string }>();
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
    // GitHub lists the granted scopes separated by commas.
    scope: "repo,workflow,project,read:org,user,read:user,user:email",
    expiringTokens: false,
  };

  const tokens = (user: string) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    access.set(accessToken, user);
    const result = { access_token: accessToken, token_type: "bearer", scope: state.scope };

    if (!state.expiringTokens) return Response.json(result);
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    refresh.set(refreshToken, user);

    return Response.json({
      ...result,
      refresh_token: refreshToken,
      expires_in: 28800,
      refresh_token_expires_in: 15811200,
    });
  };

  return {
    state,
    calls,
    revokeAccess: () => access.clear(),
    authorize: (location: string, user: string) => {
      const url = new URL(location);
      const redirect = z.url().parse(url.searchParams.get("redirect_uri"));
      const challenge = z.string().min(1).parse(url.searchParams.get("code_challenge"));
      const oauthState = z.string().min(1).parse(url.searchParams.get("state"));

      if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("Missing PKCE");
      const code = crypto.randomUUID();
      codes.set(code, { user, challenge, redirect });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", oauthState);

      return callback.href;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.href === "https://github.com/login/oauth/access_token") {
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

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      if (!user) return Response.json({ message: "Bad credentials" }, { status: 401 });

      // Better Auth reads the account that authorized the app.
      if (url.href === "https://api.github.com/user")
        return Response.json({
          id: Number(user),
          login: `user-${user}`,
          name: user,
          email: `${user}@example.test`,
        });

      if (url.href === "https://api.github.com/user/emails")
        return Response.json([{ email: `${user}@example.test`, verified: true, primary: true }]);

      if (url.href !== "https://api.github.com/graphql" || request.method !== "POST")
        throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);

      // GitHub refuses API requests without a user agent.
      if (!request.headers.get("user-agent")) return new Response(null, { status: 403 });
      calls.push(graphqlRequest.parse(await request.json()));

      if (state.apiStatus !== 200)
        return Response.json(
          { message: "API rate limit exceeded or access denied" },
          { status: state.apiStatus, headers: state.apiHeaders },
        );

      if (state.errors.length)
        return Response.json({ data: null, errors: state.errors }, { headers: state.apiHeaders });

      const field = /\{ (\w+)/.exec(calls.at(-1)?.query ?? "")?.[1];

      if (field === "repository")
        return Response.json({
          data: {
            repository: { issues: { nodes: [{ number: 1, title: "Synthetic issue" }] } },
          },
        });

      if (field === "createIssue")
        return Response.json({ data: { createIssue: { issue: { number: 2 } } } });

      if (field === "deleteIssue")
        return Response.json({ data: { deleteIssue: { clientMutationId: null } } });

      return Response.json({
        errors: [
          {
            message: `Field '${field}' doesn't exist on type 'Query'`,
            extensions: { code: "undefinedField" },
          },
        ],
      });
    },
  };
};
