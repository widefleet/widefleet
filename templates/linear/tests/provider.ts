import { createHash } from "node:crypto";
import { Headers, Request, Response } from "miniflare";
import { z } from "zod";

const kind = "linear";

const rpc = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(1),
  method: z.literal("tools/call"),
  params: z.object({ name: z.string(), arguments: z.record(z.string(), z.json()) }),
});

const issue = (id: string) => ({
  id,
  title: "Synthetic issue",
  status: "In Progress",
  statusType: "started",
  priority: { value: 2, name: "High" },
  url: `https://linear.app/example/issue/${id}`,
  team: "Engineering",
  teamId: "team-1",
  assigneeId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  completedAt: null,
  dueDate: null,
});

// A synthetic Linear OAuth application and MCP server. Tool results arrive as
// server-sent events, as Linear sends them.
export const provider = () => {
  const codes = new Map<string, { user: string; challenge: string | null; redirect: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();

  const calls: { name: string; arguments: Record<string, z.infer<ReturnType<typeof z.json>>> }[] =
    [];

  const state = {
    refreshes: 0,
    unavailable: false,
    apiStatus: 200,
    apiHeaders: new Headers(),
    toolError: "",
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

  const event = (result: z.infer<ReturnType<typeof z.json>>) =>
    new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });

  const output = (value: z.infer<ReturnType<typeof z.json>>) =>
    event({ content: [{ type: "text", text: JSON.stringify(value) }] });

  return {
    state,
    calls,
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

      if (url.href !== "https://mcp.linear.app/mcp" || request.method !== "POST")
        throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      if (!user)
        return Response.json(
          { error: "invalid_token" },
          { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } },
        );

      if (!request.headers.get("accept")?.includes("text/event-stream"))
        return new Response(null, { status: 406 });
      const { params } = rpc.parse(await request.json());

      if (params.name === "get_user")
        return output({
          id: `user-${user}`,
          name: user,
          email: `${user}@example.test`,
          displayName: user,
          isActive: true,
        });
      calls.push(params);

      if (state.apiStatus !== 200)
        return new Response(null, { status: state.apiStatus, headers: state.apiHeaders });

      if (state.toolError)
        return event({ content: [{ type: "text", text: state.toolError }], isError: true });

      if (params.name === "list_issues")
        return output({ issues: [issue("ENG-1")], hasNextPage: false });

      if (params.name === "save_issue")
        return output({ ...issue("ENG-2"), title: z.string().parse(params.arguments["title"]) });

      if (params.name === "delete_comment") return output({ deleted: true });

      if (params.name === "get_workspace") return output({ id: "workspace-1", name: "Example" });

      if (params.name === "extract_images")
        return event({
          content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        });

      // Linear answers a tool its token cannot use as unknown.
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: `Tool ${params.name} not found` } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  };
};
