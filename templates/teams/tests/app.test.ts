import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provider } from "./provider.ts";

describe("Teams personal account app", () => {
  const origin = "https://microsoft.example.test:25453";
  let runtime: Miniflare;
  let upstream: ReturnType<typeof provider>;
  let script: string;
  beforeAll(async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url).href)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["cloudflare:*", "node:*"],
    });

    script = z.string().parse(result.outputFiles[0]?.text);
  });

  const configuration = (configured = true) =>
    ({
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: "account-test",
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: script } },
            },
            env: {
              DB: { type: "d1", id: "accounts" },
              WIDEFLEET_ORIGIN: { type: "json", value: origin },
              MICROSOFT_CLIENT_ID: {
                type: "json",
                value: configured ? "test-microsoft-client" : "",
              },
              MICROSOFT_CLIENT_SECRET: {
                type: "json",
                value: configured ? "test-microsoft-secret" : "",
              },
            },
          },
          dev: { outboundService: { type: "fetcher", handler: upstream.fetch } },
        },
      ],
    }) satisfies MiniflareOptions;

  beforeEach(async () => {
    upstream = provider();
    runtime = new Miniflare(configuration());
    await runtime.ready;
  });
  afterEach(async () => {
    await runtime?.dispose();
  });

  const browser = (subject: string) => {
    const cookies = new Map<string, string>();
    const identity = { subject, issuer: "https://identity.example.test", answer: "" };

    return {
      identity,
      request: async (path: string, method = "GET", requestOrigin = origin) => {
        const response = await runtime.dispatchFetch(new URL(path, origin).href, {
          method,
          redirect: "manual",
          headers: {
            origin: requestOrigin,
            cookie: [...cookies.values()].join("; "),
            "test-subject": identity.subject,
            "test-issuer": identity.issuer,
            "test-answer": identity.answer,
          },
        });

        for (const cookie of response.headers.getSetCookie()) {
          const value = cookie.split(";")[0] ?? "";
          cookies.set(value.split("=")[0] ?? "", value);
        }

        return response;
      },
    };
  };

  const start = async (client: ReturnType<typeof browser>) => {
    const response = await client.request("/connect", "POST");
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const destination = z.string().parse(/<a href="([^"]+)">/.exec(text)?.[1]);

    return destination.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
  };

  const connect = async (client: ReturnType<typeof browser>, user: string) => {
    const response = await client.request(upstream.authorize(await start(client), user));
    expect(response.headers.get("location"), await response.text()).toBe(`${origin}/`);
  };

  it("shows missing settings before setup without attempting OAuth", async () => {
    await runtime.setOptions(configuration(false));
    const alice = browser("alice");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "setup_required",
      missing: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain("/auth/callback/microsoft");
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });
  it("sends typed requests through generated methods and isolates users and identity issuers", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connection_required",
    });
    await connect(alice, "101");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
      accountId: "101",
    });
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "connected",
      data: {
        value: [{ id: "chat-101", topic: "Launch", chatType: "group" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?$skiptoken=page-2",
      },
    });
    // OData lists are joined with commas.
    expect(upstream.calls.map((call) => call.url)).toEqual([
      "https://graph.microsoft.com/v1.0/me/chats?%24top=5&%24select=id%2Ctopic%2CchatType",
    ]);

    // A later page is read at the address Graph gave.
    const next = "https://graph.microsoft.com/v1.0/me/chats?$skiptoken=page-2";

    expect(
      await (await alice.request(`/rpc/next?link=${encodeURIComponent(next)}`)).json(),
    ).toMatchObject({ status: "connected", data: { value: [{ id: "chat-2" }] } });
    expect(upstream.calls.at(-1)?.url).toBe(next);
    // Path parameters fill the path.
    expect(await (await alice.request("/rpc/messages")).json()).toEqual({
      status: "connected",
      data: {
        value: [
          {
            id: "message-1",
            body: { contentType: "text", content: "Status?" },
            from: { user: { id: "102", displayName: "Bob" } },
          },
        ],
      },
    });
    expect(upstream.calls.at(-1)?.url).toBe(
      "https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages?%24top=10",
    );
    expect(await (await bob.request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
    alice.identity.issuer = "https://other-identity.example.test";
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
    const db = await runtime.getD1Database("DB");

    const saved = z
      .object({ accessToken: z.string(), refreshToken: z.string() })
      .parse(await db.prepare("SELECT accessToken, refreshToken FROM account").first());

    // Encrypted through the app key binding, not with an app-held secret.
    expect(saved.accessToken).toMatch(/^v1\./);
    expect(JSON.stringify(saved)).not.toContain("synthetic-");
  });

  it("asks before sending as each user's approval level says and sends only after approval", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.calls.length = 0;

    // Messages and new chats reach other people, so they ask by default.
    expect(await (await alice.request("/rpc/send")).json()).toEqual({
      resultType: "input_required",
      inputRequests: {
        approve: {
          message: `Run the Teams change "sendChatMessage"? It sends something to other people.\n\nInput:\n${JSON.stringify(
            { chatId: "chat-1", body: { body: { contentType: "text", content: "Hello" } } },
            null,
            2,
          )}`,
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });

    for (const path of ["/rpc/chat", "/rpc/reply"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        resultType: "input_required",
      });
    expect(upstream.calls).toEqual([]);

    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/send")).json()).toEqual({ status: "declined" });
    expect(upstream.calls).toEqual([]);

    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/send")).json()).toMatchObject({
      status: "connected",
      data: { id: "message-2" },
    });
    // A new chat binds each member's user by address.
    expect(await (await alice.request("/rpc/chat")).json()).toEqual({
      status: "connected",
      data: { id: "chat-3", chatType: "oneOnOne" },
    });
    expect(await (await alice.request("/rpc/reply")).json()).toMatchObject({
      status: "connected",
      data: { id: "message-3" },
    });

    const member = (address: string) => ({
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": address,
    });

    expect(upstream.calls).toEqual([
      {
        method: "POST",
        url: "https://graph.microsoft.com/v1.0/chats/chat-1/messages",
        body: JSON.stringify({ body: { contentType: "text", content: "Hello" } }),
        type: "application/json",
      },
      {
        method: "POST",
        url: "https://graph.microsoft.com/v1.0/chats",
        body: JSON.stringify({
          chatType: "oneOnOne",
          // A name's apostrophe is doubled and the rest encoded.
          members: [
            member("https://graph.microsoft.com/v1.0/users('101')"),
            member("https://graph.microsoft.com/v1.0/users('o''brien%231%40example.test')"),
          ],
        }),
        type: "application/json",
      },
      {
        method: "POST",
        url: "https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages/message-1/replies",
        body: JSON.stringify({ body: { contentType: "text", content: "On track" } }),
        type: "application/json",
      },
    ]);

    // Asking less asks the user to confirm; then messages are sent at once.
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toMatchObject({
      resultType: "input_required",
    });
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toEqual({
      status: "updated",
      level: "none",
    });
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/send")).json()).toMatchObject({ status: "connected" });

    // Each user has their own level.
    const bob = browser("bob");
    await connect(bob, "102");
    expect(await (await bob.request("/rpc/send")).json()).toMatchObject({
      resultType: "input_required",
    });
  });

  it("lets users choose their approval level on the app's page", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    const page = await (await alice.request("/")).text();
    // Nothing here is created without asking, so no level lies between always and never.
    expect(page).toContain('value="all_changes" checked');
    expect(page).not.toContain('value="updates_and_deletions"');

    const save = (level: string, requestOrigin = origin) =>
      runtime.dispatchFetch(`${origin}/approval-level`, {
        method: "POST",
        body: new URLSearchParams({ level }).toString(),
        headers: {
          origin: requestOrigin,
          "content-type": "application/x-www-form-urlencoded",
          "test-subject": "alice",
        },
      });

    expect((await save("none", "https://other.example.test")).status).toBe(403);
    expect((await save("sometimes")).status).toBe(400);
    expect((await save("updates_and_deletions")).status).toBe(400);
    expect(await (await save("none")).json()).toEqual({ level: "none" });
    expect(await (await alice.request("/rpc/level")).json()).toMatchObject({ level: "none" });
    expect(await (await alice.request("/")).text()).toContain('value="none" checked');
  });

  it("asks only users who can run the change", async () => {
    expect(await (await browser("alice").request("/rpc/send")).json()).toMatchObject({
      status: "connection_required",
    });
    expect(await (await runtime.dispatchFetch(`${origin}/rpc/level`)).json()).toEqual({
      status: "authentication_required",
    });
  });

  it("asks users who granted fewer scopes to reconnect", async () => {
    // Without the admin-consented channel scope.
    upstream.state.scope =
      "openid profile email offline_access User.Read Chat.ReadWrite ChatMessage.Send Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send";
    const alice = browser("alice");
    await connect(alice, "101");

    for (const path of ["/rpc/list", "/rpc/status", "/rpc/send"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        status: "permission_required",
      });
    expect(upstream.calls).toEqual([]);
    // Microsoft may name Graph's scopes with their resource prefix.
    upstream.state.scope = [
      "openid profile email",
      ...[
        "Chat.ReadWrite",
        "ChatMessage.Send",
        "Team.ReadBasic.All",
        "Channel.ReadBasic.All",
        "ChannelMessage.Read.All",
        "ChannelMessage.Send",
      ].map((scope) => `https://graph.microsoft.com/${scope}`),
    ].join(" ");
    await connect(alice, "101");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
  });

  it("rejects changed callback identities, replay, cross-origin forms and public token endpoints", async () => {
    const alice = browser("alice");
    expect((await alice.request("/connect", "POST", "null")).status).toBe(403);
    const callback = upstream.authorize(await start(alice), "101");
    expect((await browser("alice").request(callback)).status).toBe(403);
    alice.identity.subject = "bob";
    expect((await alice.request(callback)).status).toBe(403);
    alice.identity.subject = "alice";
    expect((await alice.request(callback)).headers.get("location")).toBe(`${origin}/`);
    expect((await alice.request(callback)).headers.get("location")).not.toBe(`${origin}/`);

    for (const path of [
      "get-access-token",
      "refresh-token",
      "widefleet-session",
      "link-social",
      "sign-in/social",
    ])
      expect((await alice.request(`/auth/${path}`, "POST")).status).toBe(404);
    expect(
      (await runtime.dispatchFetch(origin, { headers: { "x-auth-request-user": "alice" } })).status,
    ).toBe(401);
  });
  it("refreshes tokens, preserves accounts on outages and disconnects only the current user", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    await connect(alice, "101");
    await connect(bob, "102");
    const db = await runtime.getD1Database("DB");

    const expire = async () => {
      await db
        .prepare("UPDATE account SET accessTokenExpiresAt = ?")
        .bind(Date.now() - 60000)
        .run();
    };

    await expire();
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connected",
    });
    expect(upstream.state.refreshes).toBe(1);
    await expire();
    upstream.state.unavailable = true;
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "refresh_failed",
    });
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
    upstream.state.unavailable = false;
    const pending = upstream.authorize(await start(alice), "101");
    expect((await alice.request("/disconnect", "POST")).status).toBe(303);
    expect((await alice.request(pending)).status).toBe(403);
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
    expect(await (await bob.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
  });

  it("reports Graph's errors, throttling and revoked tokens", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.state.answer = {
      status: 404,
      body: { error: { code: "itemNotFound", message: "The resource could not be found." } },
      headers: {},
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "graph_error",
      error: { code: "itemNotFound", message: "The resource could not be found.", status: 404 },
    });
    upstream.state.answer = {
      status: 429,
      body: { error: { code: "TooManyRequests", message: "Throttled" } },
      headers: { "retry-after": "20" },
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "20",
    });
    upstream.state.answer = { status: 503, body: null, headers: { "retry-after": "5" } };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "5",
    });
    // Larger responses are not read.
    upstream.state.answer = {
      status: 200,
      body: { value: [{ name: "x".repeat(9 * 1024 * 1024) }] },
      headers: {},
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "too_large",
      maximumBytes: 8 * 1024 * 1024,
    });
    upstream.state.answer = { status: 502, body: null, headers: {} };
    expect((await alice.request("/rpc/list")).status).toBe(500);
    // Requests that do not match the operation never reach Graph.
    upstream.calls.length = 0;
    expect((await alice.request("/rpc/invalid")).status).toBe(500);
    expect(
      (await alice.request(`/rpc/next?link=${encodeURIComponent("https://other.example.test/")}`))
        .status,
    ).toBe(500);
    expect(upstream.calls).toEqual([]);
    upstream.state.answer = { status: 401, body: null, headers: {} };
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "reconnect_required",
    });
  });
});
