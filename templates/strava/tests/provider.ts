import { Request, Response } from "miniflare";
import { z } from "zod";

type Answer = { status: number; body: object | null; headers: Record<string, string> };

type State = {
  refreshes: number;
  unavailable: boolean;
  // An answer that replaces the next API response.
  answer: Answer | null;
};

const api = "https://www.strava.com/api/v3";

export const allScopes =
  "read,read_all,profile:read_all,profile:write,activity:read_all,activity:write";

const activity = (id: number | string, name: string) => ({
  id: Number(id),
  id_str: String(id),
  name,
  sport_type: "Run",
  distance: 5000,
});

// A multipart form's fields, with each file as its media type and content.
const formFields = async (request: Request) => {
  const fields = new Map<string, string>();

  for (const [name, value] of await request.formData()) {
    const file = z.instanceof(Blob).safeParse(value);
    fields.set(
      name,
      file.success ? `${file.data.type}:${await file.data.text()}` : z.string().parse(value),
    );
  }

  return Object.fromEntries(fields);
};

// A synthetic Strava: its OAuth endpoints and the API operations the tests call.
export const provider = () => {
  const codes = new Map<string, { user: string; redirect: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();

  const calls: {
    method: string;
    url: string;
    body: string | null;
    type: string | null;
    form: Record<string, string> | null;
  }[] = [];

  const state: State = { refreshes: 0, unavailable: false, answer: null };

  const tokens = (user: string) => {
    const accessToken = `synthetic-access-${crypto.randomUUID()}`;
    const refreshToken = `synthetic-refresh-${crypto.randomUUID()}`;
    access.set(accessToken, user);
    refresh.set(refreshToken, user);

    // Strava's token answer names no scopes and carries the athlete.
    return Response.json({
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + 21600,
      expires_in: 21600,
      athlete: { id: Number(user), username: `athlete${user}`, firstname: "Ada", lastname: "Test" },
    });
  };

  return {
    state,
    calls,
    /** Strava's consent: the athlete may untick scopes, which the callback then leaves out. */
    authorize: (location: string, user: string, granted = allScopes) => {
      const url = new URL(location);

      if (url.origin + url.pathname !== "https://www.strava.com/oauth/authorize")
        throw new Error(`Unexpected authorization at ${url.href}`);

      if (url.searchParams.get("client_id") !== "test-strava-client")
        throw new Error("Unknown client");

      if (url.searchParams.get("scope") !== allScopes) throw new Error("Unexpected scopes");

      if (url.searchParams.has("code_challenge")) throw new Error("Strava documents no PKCE");
      const redirect = z.url().parse(url.searchParams.get("redirect_uri"));
      const oauthState = z.string().min(1).parse(url.searchParams.get("state"));
      const code = crypto.randomUUID();
      codes.set(code, { user, redirect });
      const callback = new URL(redirect);
      callback.searchParams.set("state", oauthState);
      callback.searchParams.set("code", code);
      callback.searchParams.set("scope", granted);

      return callback.href;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.href === `${api}/oauth/token` && request.method === "POST") {
        const form = new URLSearchParams(await request.text());

        if (
          form.get("client_id") !== "test-strava-client" ||
          form.get("client_secret") !== "test-strava-secret"
        )
          return Response.json({ message: "Bad Request" }, { status: 400 });

        if (form.get("grant_type") === "authorization_code") {
          const code = form.get("code") ?? "";
          const saved = codes.get(code);
          codes.delete(code);

          if (!saved || saved.redirect !== form.get("redirect_uri"))
            return Response.json({ message: "Bad Request" }, { status: 400 });

          return tokens(saved.user);
        }

        if (form.get("grant_type") === "refresh_token") {
          state.refreshes++;

          if (state.unavailable) return Response.json({ message: "Unavailable" }, { status: 503 });
          const token = form.get("refresh_token") ?? "";
          const user = refresh.get(token);

          if (!user) return Response.json({ message: "Bad Request" }, { status: 400 });
          // Refresh tokens rotate: the earlier one stops working.
          refresh.delete(token);

          return tokens(user);
        }
      }

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      if (!user)
        return Response.json(
          {
            message: "Authorization Error",
            errors: [{ resource: "Athlete", field: "access_token", code: "invalid" }],
          },
          { status: 401 },
        );
      const type = request.headers.get("content-type");

      const form = type?.startsWith("multipart/form-data") ? await formFields(request) : null;

      calls.push({
        method: request.method,
        url: url.href,
        body: form ? null : (await request.text()) || null,
        type,
        form,
      });

      if (state.answer) {
        const { status, body, headers } = state.answer;
        state.answer = null;

        return body === null
          ? new Response(null, { status, headers })
          : Response.json(body, { status, headers });
      }

      const path = `${url.origin}${url.pathname}`;

      if (path === `${api}/athlete/activities` && request.method === "GET")
        return Response.json([activity(`${user}01`, "Morning run")]);

      if (path === `${api}/activities/18014398509481985` && request.method === "GET")
        return new Response(
          // An ID a JSON number cannot hold exactly, which `id_str` keeps.
          `{"id":18014398509481985,"id_str":"18014398509481985","name":"Long run"}`,
          { headers: { "content-type": "application/json; charset=utf-8" } },
        );

      if (path === `${api}/activities` && request.method === "POST")
        return Response.json(activity(1001, "Lunch run"), { status: 201 });

      if (path === `${api}/activities/1001` && request.method === "PUT")
        return Response.json(activity(1001, "Evening run"));

      if (path === `${api}/uploads` && request.method === "POST")
        return Response.json(
          { id: 4001, id_str: "4001", status: "Your activity is still being processed." },
          { status: 201 },
        );

      if (path === `${api}/athletes/${user}/routes` && request.method === "GET")
        return Response.json([{ id: 3001, id_str: "3001", name: "Loop" }]);

      if (path === `${api}/routes/3001/export_gpx` && request.method === "GET")
        return new Response('<?xml version="1.0"?><gpx/>', {
          headers: { "content-type": "application/gpx+xml" },
        });

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};
