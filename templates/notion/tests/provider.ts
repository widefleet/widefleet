import { Request, Response } from "miniflare";
import { z } from "zod";

type Answer = { status: number; body: object | null; headers: Record<string, string> };

type State = {
  // An answer that replaces the next API response.
  answer: Answer | null;
};

const api = "https://api.notion.com/v1";

// The template's version, and the one Better Auth reads the connected person with.
const versions = ["2026-03-11", "2022-06-28"];

// A Notion user who authorizes the connection, as `GET /v1/users/me` names the bot's owner.
const person = (user: string) => ({
  object: "user",
  id: user,
  type: "person",
  name: `Person ${user}`,
  avatar_url: null,
  person: { email: `${user}@example.test` },
});

const page = (id: string, title: string) => ({
  object: "page",
  id,
  url: `https://app.notion.com/p/${id}`,
  properties: { title: { id: "title", type: "title", title: [{ plain_text: title }] } },
});

type ErrorDetails = Record<string, string | string[]>;

// Notion's error, with details such as which rate limit applied.
const error = (status: number, code: string, message: string, additional?: ErrorDetails) => ({
  status,
  body: additional
    ? {
        object: "error",
        status,
        code,
        message,
        request_id: "request-1",
        additional_data: additional,
      }
    : { object: "error", status, code, message, request_id: "request-1" },
  headers: {},
});

const session = {
  object: "session",
  id: "session-1",
  agent_id: "agent-1",
  title: "Wochenbericht",
  status: "in_progress",
  created_at: "2026-11-28T10:00:00.000Z",
  updated_at: "2026-11-28T10:00:00.000Z",
};

const reply = {
  object: "session_event",
  id: "event-1",
  session_id: "session-1",
  created_at: "2026-11-28T10:00:01.000Z",
  type: "agent.message",
  content: [{ type: "text", text: "Zusammenfassung: alles erledigt ✓" }],
};

export const provider = () => {
  const codes = new Map<string, { user: string; redirect: string }>();
  const access = new Map<string, string>();

  const calls: {
    method: string;
    url: string;
    body: string | null;
    type: string | null;
    version: string | null;
    beta: string | null;
  }[] = [];

  const uploads: { name: string; type: string; bytes: number[] }[] = [];
  const state: State = { answer: null };

  // Notion answers the code with a token that does not expire, the bot it
  // belongs to and the workspace.
  const tokens = (user: string) => {
    const accessToken = `ntn_synthetic-${crypto.randomUUID()}`;
    access.set(accessToken, user);

    return Response.json({
      access_token: accessToken,
      token_type: "bearer",
      refresh_token: `nrt_synthetic-${crypto.randomUUID()}`,
      bot_id: `bot-${user}`,
      workspace_id: "workspace-1",
      workspace_name: "Synthetic workspace",
      workspace_icon: null,
      owner: { type: "user", user: person(user) },
      duplicated_template_id: null,
      request_id: "request-1",
    });
  };

  return {
    state,
    calls,
    uploads,
    authorize: (location: string, user: string) => {
      const url = new URL(location);

      if (`${url.origin}${url.pathname}` !== `${api}/oauth/authorize`)
        throw new Error(`Unexpected authorization address ${url.href}`);

      if (url.searchParams.get("owner") !== "user") throw new Error("Notion needs owner=user");

      if (url.searchParams.get("response_type") !== "code") throw new Error("Code flow expected");
      const redirect = z.url().parse(url.searchParams.get("redirect_uri"));
      const oauthState = z.string().min(1).parse(url.searchParams.get("state"));
      const code = crypto.randomUUID();
      codes.set(code, { user, redirect });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", oauthState);

      return callback.href;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.href === `${api}/oauth/token`) {
        // Notion authenticates the integration with HTTP Basic authentication.
        if (
          request.headers.get("authorization") !==
          `Basic ${btoa("test-notion-client:test-notion-secret")}`
        )
          return Response.json({ error: "invalid_client" }, { status: 401 });
        const text = await request.text();

        const form = request.headers.get("content-type")?.includes("application/json")
          ? new URLSearchParams(z.record(z.string(), z.string()).parse(JSON.parse(text)))
          : new URLSearchParams(text);

        if (form.get("grant_type") !== "authorization_code")
          return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
        const code = form.get("code") ?? "";
        const saved = codes.get(code);
        codes.delete(code);

        if (!saved || saved.redirect !== form.get("redirect_uri"))
          return Response.json({ error: "invalid_grant" }, { status: 400 });

        return tokens(saved.user);
      }

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      if (!user)
        return Response.json(
          { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." },
          { status: 401 },
        );

      // Notion answers every API version it released; the tests check which one
      // the template's calls send.
      if (!versions.includes(request.headers.get("notion-version") ?? ""))
        return Response.json(error(400, "missing_version", "Notion-Version is required").body, {
          status: 400,
        });

      // Better Auth reads the person who connected from the token's bot.
      if (url.href === `${api}/users/me`)
        return Response.json({
          object: "user",
          id: `bot-${user}`,
          type: "bot",
          name: "Widefleet",
          bot: { owner: { type: "user", user: person(user) }, workspace_name: "Synthetic" },
        });

      const type = request.headers.get("content-type");

      if (type?.startsWith("multipart/form-data")) {
        const form = await request.formData();
        const file = form.get("file");

        if (!(file instanceof File)) throw new Error("The upload needs a file part");
        uploads.push({
          name: file.name,
          type: file.type,
          bytes: [...new Uint8Array(await file.arrayBuffer())],
        });
        calls.push({
          method: request.method,
          url: url.href,
          body: null,
          type,
          version: request.headers.get("notion-version"),
          beta: request.headers.get("notion-beta"),
        });
      } else
        calls.push({
          method: request.method,
          url: url.href,
          body: (await request.text()) || null,
          type,
          version: request.headers.get("notion-version"),
          beta: request.headers.get("notion-beta"),
        });

      if (state.answer) {
        const { status, body, headers } = state.answer;
        state.answer = null;

        return body === null
          ? new Response(null, { status, headers })
          : Response.json(body, { status, headers });
      }

      const path = `${url.origin}${url.pathname}`;

      if (path === `${api}/search` && request.method === "POST")
        return Response.json({
          object: "list",
          results: [page(`page-${user}`, "Roadmap")],
          next_cursor: null,
          has_more: false,
          type: "page_or_data_source",
          page_or_data_source: {},
        });

      if (path === `${api}/blocks/page-1/children` && request.method === "GET")
        return Response.json({
          object: "list",
          results: [{ object: "block", id: "block-1", type: "paragraph" }],
          next_cursor: url.searchParams.has("start_cursor") ? null : "cursor-2",
          has_more: !url.searchParams.has("start_cursor"),
          type: "block",
          block: {},
        });

      if (path === `${api}/pages` && request.method === "POST")
        return Response.json(page("page-2", "Notes"));

      if (path === `${api}/blocks/block-1` && request.method === "DELETE")
        return Response.json({ object: "block", id: "block-1", in_trash: true });

      if (path === `${api}/sessions` && request.method === "POST") {
        // A stream carries the turn's events; JSON carries the session.
        if (request.headers.get("accept") === "text/event-stream")
          return new Response(
            [
              { type: "session.snapshot", session: { ...session, status: "queued" } },
              { type: "event.provisional", event: { ...reply, text: "Zusammenfass" } },
              { type: "event.committed", event: reply },
              { type: "stream.end", session_id: "session-1", status: "completed" },
            ]
              .map((envelope) => `event: message\ndata: ${JSON.stringify(envelope)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream; charset=utf-8" } },
          );

        return Response.json(session);
      }

      // Property IDs arrive as Notion encoded them.
      if (url.pathname === "/v1/pages/page-1/properties/f%5C%5C%3Ap" && request.method === "GET")
        return Response.json({
          object: "property_item",
          id: "f%5C%5C%3Ap",
          type: "number",
          number: 7,
        });

      if (path === `${api}/file_uploads/upload-1/send` && request.method === "POST")
        return Response.json({ object: "file_upload", id: "upload-1", status: "uploaded" });

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};

export { error };
