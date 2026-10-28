import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { accessToken, authentication, userId } from "./auth.ts";
import {
  appOrigins,
  basePath,
  callerKey,
  properties,
  type Environment,
  type Properties,
} from "./context.ts";
import schema from "../migrations/0001-better-auth.sql";

const initialized = new WeakSet<D1Database>();

const initialize = async (database: D1Database) => {
  if (initialized.has(database)) return;
  // Each request owns its I/O. Sharing an in-flight D1 promise across requests
  // lets one request finishing cancel initialization awaited by another.
  await database.batch(
    schema
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => database.prepare(sql)),
  );
  initialized.add(database);
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const account = z.object({ id: z.string(), accountId: z.string() });

const issue = z.object({ id: z.number(), title: z.string() });

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location, "cache-control": "no-store" });

  for (const cookie of cookies) headers.append("set-cookie", cookie);

  return new Response(null, { status: 303, headers });
};

const withCookies = (headers: Headers, cookies: string[]) => {
  const result = new Headers(headers);
  const values = new Map<string, string>();

  for (const value of (headers.get("cookie") ?? "").split(";")) {
    const cookie = value.trim();

    if (cookie) values.set(cookie.split("=")[0] ?? "", cookie);
  }

  for (const value of cookies) {
    const cookie = value.split(";")[0] ?? "";
    values.set(cookie.split("=")[0] ?? "", cookie);
  }

  result.set("cookie", [...values.values()].join("; "));

  return result;
};

export default class GitHubConnector extends WorkerEntrypoint<Environment, Properties> {
  #identity() {
    return properties.parse(this.ctx.props).caller;
  }
  async #account() {
    await initialize(this.env.DB);
    const id = await userId(this.env.DB, await callerKey(this.#identity()));

    if (!id) return null;

    const row = await this.env.DB.prepare(
      'SELECT id, "accountId" FROM account WHERE "userId" = ? AND "providerId" = ?',
    )
      .bind(id, "github")
      .first();

    return row ? { ...account.parse(row), userId: id } : null;
  }
  async connectionStatus() {
    const saved = await this.#account();

    return saved
      ? { status: "connected", githubAccountId: saved.accountId }
      : { status: "connection_required" };
  }
  async listIssues() {
    const saved = await this.#account();

    if (!saved) return { status: "connection_required", issues: [] };

    const token = await accessToken(this.env, this.#identity(), {
      userId: saved.userId,
      accountId: saved.id,
    });

    if (!token) return { status: "reconnect_required", issues: [] };

    const response = await fetch(`${this.env.PROVIDER_API_ORIGIN}/issues`, {
      headers: { authorization: `Bearer ${token.accessToken}`, accept: "application/json" },
    });

    if (response.status === 401) return { status: "reconnect_required", issues: [] };

    if (!response.ok) throw new Error("GitHub issues request failed");

    return { status: "connected", issues: z.array(issue).parse(await response.json()) };
  }
  override async fetch(request: Request) {
    await initialize(this.env.DB);
    const identity = this.#identity();
    const url = new URL(request.url);
    const path = basePath(this.env);

    const returnTo = (value: File | string | null) => {
      const target = z.url().safeParse(value);

      return target.success && appOrigins(this.env).includes(new URL(target.data).origin)
        ? target.data
        : null;
    };

    if (url.origin !== this.env.CONNECTOR_ORIGIN) return new Response(null, { status: 400 });
    const auth = await authentication(this.env, identity);

    if (url.pathname === `${path}/` && request.method === "GET") {
      const target = returnTo(url.searchParams.get("returnTo")) ?? `${url.origin}/`;
      const saved = await this.#account();

      return new Response(
        `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GitHub verbinden</title><style>body{font:17px system-ui;max-width:600px;margin:80px auto;padding:24px;color:#222}button,a{font:inherit}button{padding:12px 18px;cursor:pointer}form{margin:24px 0}small{color:#666}</style><small>Widefleet · persönliche Verbindung</small><h1>GitHub ${saved ? "verbunden" : "verbinden"}</h1><p>Angemeldet als ${escapeHtml(identity.name)}.</p><p>${saved ? `GitHub-Konto ${escapeHtml(saved.accountId)} ist verbunden. Alle Apps mit diesem Connector können es für dich verwenden.` : "Verbinde dein GitHub-Konto einmal. Anschließend können Apps mit diesem Connector es für dich verwenden."}</p><form method="post" action="${path}/${saved ? "disconnect" : "connect"}"><input type="hidden" name="returnTo" value="${escapeHtml(target)}"><button>${saved ? "Verbindung trennen" : "Mit GitHub verbinden"}</button></form><a href="${escapeHtml(target)}">Zurück zur App</a></html>`,
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
      );
    }

    if (
      [`${path}/connect`, `${path}/disconnect`].includes(url.pathname) &&
      request.method === "POST"
    ) {
      if (request.headers.get("origin") !== url.origin)
        return new Response("Invalid origin", { status: 403 });

      const established = await auth.api.establishConnectorSession({
        headers: request.headers,
        asResponse: true,
      });

      if (!established.ok) return established;
      const cookies = established.headers.getSetCookie();
      const headers = withCookies(request.headers, cookies);

      const form = await request.formData();
      const target = returnTo(form.get("returnTo"));

      if (url.pathname === `${path}/disconnect`) {
        const saved = await this.#account();

        if (saved) await auth.api.unlinkAccount({ headers, body: { accountId: saved.id } });

        return redirect(target ?? "/", cookies);
      }

      if (!target) return new Response("Invalid return URL", { status: 400 });

      const result = await auth.api.linkSocialAccount({
        headers,
        body: {
          provider: "github",
          callbackURL: target,
          errorCallbackURL: `${url.origin}${path}/error`,
          disableRedirect: true,
        },
        asResponse: true,
      });

      if (!result.ok) return result;
      const destination = z.object({ url: z.url() }).parse(await result.json()).url;

      return redirect(destination, [...cookies, ...result.headers.getSetCookie()]);
    }

    if (url.pathname === `${path}/auth/callback/github` && request.method === "GET") {
      const session = await auth.api.getSession({ headers: request.headers });
      const expected = await userId(this.env.DB, await callerKey(identity));

      if (!expected || session?.user.id !== expected)
        return new Response("The initiating user session no longer matches", { status: 403 });

      return auth.handler(request);
    }

    if (url.pathname === `${path}/error`)
      return new Response("Connecting GitHub failed. Return to the app and try again.", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });

    // Token-returning and session-bootstrap endpoints are callable only inside this connector.
    return new Response(null, { status: 404 });
  }
}
