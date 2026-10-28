import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { escapeHtml, page } from "./pages.ts";

const account = z.enum(["alice", "bob"]);

const people = {
  alice: { id: 101, name: "Alice", login: "alice-test" },
  bob: { id: 202, name: "Bob", login: "bob-test" },
};

export const createProvider = async (hostname = "127.0.0.1") => {
  const codes = new Map<
    string,
    { user: z.infer<typeof account>; challenge: string; redirect: string }
  >();

  const accessTokens = new Map<string, z.infer<typeof account>>();
  const refreshTokens = new Map<string, z.infer<typeof account>>();

  const stats = {
    authorizations: 0,
    exchanges: 0,
    refreshes: 0,
    refreshFailures: 0,
    profiles: 0,
    issues: 0,
  };

  let refreshDelay = 0;
  let origin = "";
  let callbackURL = "";

  const issueTokens = (user: z.infer<typeof account>) => {
    const accessToken = `synthetic-access-${randomUUID()}`;
    const refreshToken = `synthetic-refresh-${randomUUID()}`;
    accessTokens.set(accessToken, user);
    refreshTokens.set(refreshToken, user);

    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: 3600,
      refresh_token_expires_in: 86400,
      scope: "read:user",
    });
  };

  const handle = async (request: Request) => {
    const url = new URL(request.url);

    if (url.pathname === "/login/oauth/authorize") {
      const params = z
        .object({
          client_id: z.literal("local-github-client"),
          redirect_uri: z.url(),
          state: z.string().min(1),
          code_challenge: z.string().min(1),
          code_challenge_method: z.literal("S256"),
        })
        .parse(Object.fromEntries(url.searchParams));

      const target = new URL(params.redirect_uri);

      if (params.redirect_uri !== callbackURL)
        return new Response("Unregistered callback", { status: 400 });

      if (request.method === "GET")
        return page(
          "GitHub-Testkonto autorisieren",
          `<h1>GitHub-Testanbieter</h1><p>Dieser lokale Anbieter simuliert OAuth. Es werden keine echten GitHub-Konten verwendet.</p><section class="panel"><h2>Welches Testkonto verbinden?</h2><p>Callback: <code>${escapeHtml(target.href)}</code></p>${Object.entries(
            people,
          )
            .map(
              ([id, person]) =>
                `<form method="post" action="${escapeHtml(url.pathname + url.search)}"><input type="hidden" name="account" value="${id}"><button>${person.name} autorisieren</button></form>`,
            )
            .join(
              "",
            )}<form method="post" action="${escapeHtml(url.pathname + url.search)}"><input type="hidden" name="cancel" value="yes"><button class="secondary">Abbrechen</button></form></section>`,
        );

      const form = await request.formData();
      target.searchParams.set("state", params.state);

      if (form.get("cancel") === "yes") target.searchParams.set("error", "access_denied");
      else {
        const user = account.parse(form.get("account"));
        const code = randomUUID();
        codes.set(code, { user, challenge: params.code_challenge, redirect: params.redirect_uri });
        target.searchParams.set("code", code);
        stats.authorizations++;
      }

      return new Response(null, { status: 303, headers: { location: target.href } });
    }

    if (url.pathname === "/login/oauth/access_token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());

      if (
        form.get("client_id") !== "local-github-client" ||
        form.get("client_secret") !== "local-github-secret"
      )
        return Response.json({ error: "invalid_client" }, { status: 401 });

      if (form.get("grant_type") === "refresh_token") {
        if (refreshDelay) await new Promise((resolve) => setTimeout(resolve, refreshDelay));
        const value = form.get("refresh_token") ?? "";
        const user = refreshTokens.get(value);

        if (!user) {
          stats.refreshFailures++;

          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }

        refreshTokens.delete(value);
        stats.refreshes++;

        return issueTokens(user);
      }

      const code = form.get("code") ?? "";
      const saved = codes.get(code);

      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");

      if (!saved || challenge !== saved.challenge || form.get("redirect_uri") !== saved.redirect)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      codes.delete(code);
      stats.exchanges++;

      return issueTokens(saved.user);
    }

    const user = accessTokens.get(
      (request.headers.get("authorization") ?? "").replace(/^Bearer /, ""),
    );

    if (!user) return Response.json({ message: "Bad credentials" }, { status: 401 });

    if (url.pathname === "/user") {
      stats.profiles++;

      return Response.json({ ...people[user], email: `${user}@github.example.test` });
    }

    if (url.pathname === "/issues") {
      stats.issues++;

      return Response.json([
        { id: people[user].id, title: `Issue visible to ${people[user].name}` },
      ]);
    }

    return new Response(null, { status: 404 });
  };

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: string[] = [];
      incoming.setEncoding("utf8");

      for await (const chunk of incoming) chunks.push(z.string().parse(chunk));
      const method = incoming.method ?? "GET";
      const headers = new Headers();

      for (const [name, value] of Object.entries(incoming.headers))
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);

      const result = await handle(
        new Request(`${origin}${incoming.url ?? "/"}`, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? null : chunks.join(""),
        }),
      );

      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(new Uint8Array(await result.arrayBuffer()));
    })().catch((cause: unknown) => {
      const failure = z.instanceof(Error).parse(cause);
      outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end(failure.message);
    });
  });

  server.listen(0, hostname);
  await once(server, "listening");
  origin = `http://${hostname}:${z.object({ port: z.number() }).parse(server.address()).port}`;

  return {
    origin,
    stats,
    setCallbackURL: (value: string) => {
      callbackURL = value;
    },
    setCallbackOrigin: (connectorOrigin: string) => {
      callbackURL = new URL("/connector/auth/callback/github", connectorOrigin).href;
    },
    setRefreshDelay: (milliseconds: number) => {
      refreshDelay = milliseconds;
    },
    revoke: (user: z.infer<typeof account>) => {
      for (const [token, owner] of accessTokens) if (owner === user) accessTokens.delete(token);
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
