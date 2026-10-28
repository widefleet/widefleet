import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { authentication, callbackPath } from "./auth.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { initialize } from "./database.ts";
import { gmailScope, providerId } from "./google.ts";
import { connectionPage } from "./page.ts";

const linkedAccount = z.object({
  id: z.string(),
  accountId: z.string(),
  scope: z.string().nullable(),
  providerEmail: z.email().nullable(),
});

const messageList = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

const messageMetadata = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string(),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })) }),
});

const listInput = z.object({
  maxResults: z.number().int().min(1).max(100).default(20),
  pageToken: z.string().max(2048).optional(),
});

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location, "cache-control": "no-store" });

  for (const cookie of cookies) headers.append("set-cookie", cookie);

  return new Response(null, { status: 303, headers });
};

export default class GmailConnector extends WorkerEntrypoint<Environment, Properties> {
  async #context() {
    const identity = caller.parse(this.ctx.props.caller);
    await initialize(this.env.DB);

    return { identity, id: await callerId(identity) };
  }

  async #account(id: string) {
    const row = await this.env.DB.prepare(
      'SELECT account.id, accountId, scope, providerEmail FROM account JOIN "user" ON "user".id = account.userId WHERE userId = ? AND providerId = ?',
    )
      .bind(id, providerId)
      .first();

    return row ? linkedAccount.parse(row) : null;
  }

  async connectionStatus() {
    const { id } = await this.#context();
    const account = await this.#account(id);

    return { connected: account !== null, googleAccountId: account?.accountId ?? null };
  }

  async #gmail(path: string) {
    const { identity, id } = await this.#context();
    const account = await this.#account(id);

    if (!account) return { status: "connection_required" } as const;

    if (!account.scope?.split(",").includes(gmailScope))
      return { status: "permission_required" } as const;

    const auth = await authentication(this.env, identity, id);

    const token = await auth.api.getAccessToken({
      body: { userId: id, accountId: account.id },
      asResponse: true,
    });

    // Better Auth deliberately hides the upstream refresh error. Do not claim that
    // a network/provider failure means the user's consent was revoked, or delete tokens.
    if (!token.ok) {
      const error = z.object({ code: z.string() }).parse(await token.json());

      if (error.code === "FAILED_TO_GET_ACCESS_TOKEN") return { status: "refresh_failed" } as const;
      throw new Error("Could not load the Gmail connection");
    }

    const { accessToken } = z.object({ accessToken: z.string().min(1) }).parse(await token.json());

    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 401) return { status: "reconnect_required" } as const;

    if (response.status === 403) return { status: "access_denied" } as const;

    if (!response.ok) throw new Error(`Gmail request failed (HTTP ${response.status})`);

    return { status: "connected", response } as const;
  }

  async listMessages(input: z.input<typeof listInput> = {}) {
    const options = listInput.parse(input);
    const query = new URLSearchParams({ maxResults: String(options.maxResults) });

    if (options.pageToken) query.set("pageToken", options.pageToken);
    const result = await this.#gmail(`messages?${query.toString()}`);

    if (result.status !== "connected") return result;

    return { status: "connected", ...messageList.parse(await result.response.json()) } as const;
  }

  async getMessage(id: string) {
    const messageId = z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(256)
      .parse(id);

    const result = await this.#gmail(`messages/${messageId}?format=metadata`);

    if (result.status !== "connected") return result;

    return {
      status: "connected",
      message: messageMetadata.parse(await result.response.json()),
    } as const;
  }

  override async fetch(request: Request) {
    if (!caller.safeParse(this.ctx.props.caller).success)
      return new Response(null, { status: 401 });
    const { identity, id } = await this.#context();
    const url = new URL(request.url);

    if (url.origin !== this.env.WIDEFLEET_ORIGIN) return new Response(null, { status: 400 });

    if (url.pathname === "/" && request.method === "GET") {
      const account = await this.#account(id);

      return connectionPage(
        identity.name,
        account?.providerEmail ?? account?.accountId ?? null,
        url.searchParams.has("error"),
      );
    }

    if (["/connect", "/disconnect"].includes(url.pathname) && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin)
        return new Response("Invalid origin", { status: 403 });

      if (url.pathname === "/disconnect") {
        await this.env.DB.batch([
          this.env.DB.prepare("DELETE FROM account WHERE userId = ? AND providerId = ?").bind(
            id,
            providerId,
          ),
          this.env.DB.prepare("DELETE FROM session WHERE userId = ?").bind(id),
        ]);

        return redirect("/");
      }

      const auth = await authentication(this.env, identity, id);

      const established = await auth.api.establishSession({
        headers: request.headers,
        asResponse: true,
      });

      if (!established.ok) throw new Error("Could not establish the account-linking session");
      const cookies = established.headers.getSetCookie();

      const headers = new Headers({
        origin: url.origin,
        cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
      });

      const linked = await auth.api.linkSocialAccount({
        headers,
        body: {
          provider: providerId,
          callbackURL: `${url.origin}/`,
          errorCallbackURL: `${url.origin}/?error=connection`,
          disableRedirect: true,
        },
        asResponse: true,
      });

      if (!linked.ok) return redirect("/?error=connection", cookies);
      const location = z.object({ url: z.url() }).parse(await linked.json()).url;

      return redirect(location, [...cookies, ...linked.headers.getSetCookie()]);
    }

    if (url.pathname === callbackPath && request.method === "GET") {
      const auth = await authentication(this.env, identity, id);
      const session = await auth.api.getSession({ headers: request.headers });

      if (session?.user.id !== id)
        return new Response(
          "The user who started this connection is no longer signed in. Start again.",
          { status: 403 },
        );

      return auth.handler(request);
    }

    // Only the OAuth callback is exposed. Better Auth's session, token and sign-in
    // endpoints remain private, including the custom session bootstrap above.
    return new Response(null, { status: 404 });
  }
}
