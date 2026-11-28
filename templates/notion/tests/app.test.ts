import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { error, provider } from "./provider.ts";

describe("Notion personal account app", () => {
  const origin = "https://notion.example.test:25453";
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
              NOTION_CLIENT_ID: {
                type: "json",
                value: configured ? "test-notion-client" : "",
              },
              NOTION_CLIENT_SECRET: {
                type: "json",
                value: configured ? "test-notion-secret" : "",
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

    const address = destination.replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    );

    return address;
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
      missing: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain("/auth/callback/notion");
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });

  it("sends typed requests in Notion's API version and isolates users and identity issuers", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connection_required",
    });
    await connect(alice, "user-101");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
      accountId: "user-101",
    });
    // The page names the person who connected.
    expect(await (await alice.request("/")).text()).toContain("user-101@example.test");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "connected",
      data: {
        object: "list",
        results: [
          {
            object: "page",
            id: "page-user-101",
            url: "https://app.notion.com/p/page-user-101",
            properties: {
              title: { id: "title", type: "title", title: [{ plain_text: "Roadmap" }] },
            },
          },
        ],
        next_cursor: null,
        has_more: false,
        type: "page_or_data_source",
        page_or_data_source: {},
      },
    });
    expect(upstream.calls).toEqual([
      {
        method: "POST",
        url: "https://api.notion.com/v1/search",
        body: JSON.stringify({ query: "Roadmap", filter: { property: "object", value: "page" } }),
        type: "application/json",
        version: "2026-03-11",
        beta: null,
      },
    ]);

    // A later page continues at the cursor Notion gave; betas pass through.
    expect(await (await alice.request("/rpc/children")).json()).toMatchObject({
      status: "connected",
      data: { has_more: true, next_cursor: "cursor-2" },
    });
    expect(
      await (
        await alice.request("/rpc/children?cursor=cursor-2&beta=status-group-filters-2026-10-06")
      ).json(),
    ).toMatchObject({ status: "connected", data: { has_more: false } });
    expect(upstream.calls.slice(1).map(({ url, beta }) => ({ url, beta }))).toEqual([
      { url: "https://api.notion.com/v1/blocks/page-1/children?page_size=50", beta: null },
      {
        url: "https://api.notion.com/v1/blocks/page-1/children?start_cursor=cursor-2&page_size=50",
        beta: "status-group-filters-2026-10-06",
      },
    ]);
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

  it("asks before changes as each user's approval level says and runs them only after approval", async () => {
    const alice = browser("alice");
    await connect(alice, "user-101");
    upstream.calls.length = 0;

    // By default, creating runs at once; deleting and messaging an agent ask first.
    expect(await (await alice.request("/rpc/create?title=Café notes ✓")).json()).toMatchObject({
      status: "connected",
      data: { id: "page-2" },
    });
    expect(upstream.calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.notion.com/v1/pages",
      body: JSON.stringify({
        parent: { page_id: "page-1" },
        properties: { title: { title: [{ text: { content: "Café notes ✓" } }] } },
      }),
      type: "application/json",
    });
    expect(await (await alice.request("/rpc/delete")).json()).toEqual({
      resultType: "input_required",
      inputRequests: {
        approve: {
          message: `Run the Notion change "deleteBlock"? It deletes or replaces data.\n\nInput:\n${JSON.stringify({ block_id: "block-1" }, null, 2)}`,
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });
    expect(await (await alice.request("/rpc/message")).json()).toMatchObject({
      resultType: "input_required",
    });
    expect(upstream.calls).toHaveLength(1);

    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/delete")).json()).toEqual({ status: "declined" });
    expect(upstream.calls).toHaveLength(1);

    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/delete")).json()).toMatchObject({
      status: "connected",
      data: { id: "block-1", in_trash: true },
    });
    expect(await (await alice.request("/rpc/message")).json()).toMatchObject({
      status: "connected",
      data: { id: "session-1", status: "in_progress" },
    });
    expect(upstream.calls.slice(1).map(({ method, url }) => `${method} ${url}`)).toEqual([
      "DELETE https://api.notion.com/v1/blocks/block-1",
      "POST https://api.notion.com/v1/sessions",
    ]);

    // Asking more takes effect at once; then creating asks too.
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/set-level?level=all_changes")).json()).toEqual({
      status: "updated",
      level: "all_changes",
    });
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      resultType: "input_required",
    });

    // Each user has their own level.
    const bob = browser("bob");
    await connect(bob, "user-102");
    expect(await (await bob.request("/rpc/create")).json()).toMatchObject({ status: "connected" });
  });

  it("streams a session turn as Notion's events, after approval", async () => {
    const alice = browser("alice");
    await connect(alice, "user-101");

    const question = z
      .object({ inputRequests: z.object({ approve: z.object({ message: z.string() }) }) })
      .parse(await (await alice.request("/rpc/stream")).json());

    expect(question.inputRequests.approve.message).toContain('"streamSessionMessage"');
    alice.identity.answer = "accept";

    const streamed = z
      .object({
        status: z.literal("connected"),
        data: z.array(
          z.looseObject({
            type: z.string(),
            session: z.looseObject({ status: z.string() }).optional(),
            event: z
              .looseObject({ id: z.string(), content: z.array(z.looseObject({})).optional() })
              .optional(),
            status: z.string().optional(),
          }),
        ),
      })
      .parse(await (await alice.request("/rpc/stream")).json());

    expect(streamed.data.map(({ type }) => type)).toEqual([
      "session.snapshot",
      "event.provisional",
      "event.committed",
      "stream.end",
    ]);
    expect(streamed.data[0]?.session?.status).toBe("queued");
    expect(streamed.data[2]?.event?.content).toEqual([
      { type: "text", text: "Zusammenfassung: alles erledigt ✓" },
    ]);
    expect(streamed.data[3]?.status).toBe("completed");
  });

  it("sends property IDs as Notion encoded them, and only such IDs", async () => {
    const alice = browser("alice");
    await connect(alice, "user-101");
    upstream.calls.length = 0;
    expect(
      await (await alice.request(`/rpc/property?id=${encodeURIComponent("f%5C%5C%3Ap")}`)).json(),
    ).toMatchObject({ status: "connected", data: { id: "f%5C%5C%3Ap", number: 7 } });
    expect(upstream.calls[0]?.url).toBe(
      "https://api.notion.com/v1/pages/page-1/properties/f%5C%5C%3Ap",
    );

    for (const id of ["a/b", "a?b", "%zz", ".."])
      expect((await alice.request(`/rpc/property?id=${encodeURIComponent(id)}`)).status).toBe(500);
    expect(upstream.calls).toHaveLength(1);
  });

  it("uploads a file's bytes as a multipart part", async () => {
    const alice = browser("alice");
    await connect(alice, "user-101");
    const bytes = [0, 255, 128, 10, 13, 0x7f, 0xc3, 0x28];

    expect(
      await (
        await alice.request(
          `/rpc/upload?base64=${encodeURIComponent(btoa(String.fromCharCode(...bytes)))}`,
        )
      ).json(),
    ).toMatchObject({ status: "connected", data: { id: "upload-1", status: "uploaded" } });
    expect(upstream.uploads).toEqual([{ name: "file", type: "application/octet-stream", bytes }]);
    expect(upstream.calls.at(-1)).toMatchObject({ version: "2026-03-11" });
  });

  it("lets users choose their approval level on the app's page", async () => {
    const alice = browser("alice");
    await connect(alice, "user-101");
    const page = await (await alice.request("/")).text();
    expect(page).toContain('value="updates_and_deletions" checked');

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
    expect(await (await save("none")).json()).toEqual({ level: "none" });
    expect(await (await alice.request("/rpc/level")).json()).toMatchObject({ level: "none" });
    expect(await (await alice.request("/")).text()).toContain('value="none" checked');
  });

  it("asks only users who can run the change", async () => {
    expect(await (await browser("alice").request("/rpc/delete")).json()).toMatchObject({
      status: "connection_required",
    });
    expect(await (await runtime.dispatchFetch(`${origin}/rpc/level`)).json()).toEqual({
      status: "authentication_required",
    });
  });

  it("rejects changed callback identities, replay, cross-origin forms and public token endpoints", async () => {
    const alice = browser("alice");
    expect((await alice.request("/connect", "POST", "null")).status).toBe(403);
    const callback = upstream.authorize(await start(alice), "user-101");
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

  it("keeps a connection to one Notion user, reconnects it and disconnects only the current user", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    await connect(alice, "user-101");
    await connect(bob, "user-102");

    // Reconnecting, such as to share more pages, keeps the same Notion user.
    await connect(alice, "user-101");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connected",
    });
    const switched = await alice.request(upstream.authorize(await start(alice), "user-103"));
    expect(switched.headers.get("location")).toContain("error=");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      accountId: "user-101",
    });

    const pending = upstream.authorize(await start(alice), "user-101");
    expect((await alice.request("/disconnect", "POST")).status).toBe(303);
    expect((await alice.request(pending)).status).toBe(403);
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
    expect(await (await bob.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
  });

  it("reports Notion's errors, rate limits, overload and revoked tokens", async () => {
    const alice = browser("alice");
    await connect(alice, "user-101");
    upstream.state.answer = error(404, "object_not_found", "Could not find page with ID: x.");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "notion_error",
      error: {
        status: 404,
        code: "object_not_found",
        message: "Could not find page with ID: x.",
        requestId: "request-1",
        additionalData: null,
      },
    });

    const limited = (reason: string, status = 429) => ({
      ...error(status, status === 429 ? "rate_limited" : "service_overload", "Slow down.", {
        rate_limit_reason: reason,
        retry_after: "20",
      }),
      headers: { "retry-after": "20" },
    });

    upstream.state.answer = limited("public_api_request_rate_limit");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "20",
    });
    upstream.state.answer = limited("", 529);
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "20",
    });
    // A connection Notion blocked gains nothing from waiting.
    upstream.state.answer = limited("public_api_request_blocked");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "notion_error",
      error: { status: 429, additionalData: { rate_limit_reason: "public_api_request_blocked" } },
    });

    // A write whose answer timed out reports what Notion saved.
    alice.identity.answer = "accept";
    upstream.state.answer = error(503, "service_unavailable", "The change was saved.", {
      retry_guidance: [
        "Read the object again to confirm the saved change.",
        "Do not repeat the write.",
      ],
      committed_resource_id: "page-3",
    });
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      status: "notion_error",
      error: { status: 503, additionalData: { committed_resource_id: "page-3" } },
    });
    alice.identity.answer = "";

    // Larger responses are not read.
    upstream.state.answer = {
      status: 200,
      body: { results: [{ id: "x".repeat(9 * 1024 * 1024) }] },
      headers: {},
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "too_large",
      maximumBytes: 8 * 1024 * 1024,
    });
    upstream.state.answer = { status: 502, body: null, headers: {} };
    expect((await alice.request("/rpc/list")).status).toBe(500);
    // Requests that do not match the operation never reach Notion.
    upstream.calls.length = 0;
    expect((await alice.request("/rpc/invalid")).status).toBe(500);
    expect(upstream.calls).toEqual([]);
    upstream.state.answer = error(401, "unauthorized", "API token is invalid.");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "reconnect_required",
    });
  });
});
