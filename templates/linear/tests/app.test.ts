import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provider } from "./provider.ts";

describe("Linear personal account app", () => {
  const origin = "https://linear.example.test:25453";
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
              LINEAR_CLIENT_ID: {
                type: "json",
                value: configured ? "test-linear-client" : "",
              },
              LINEAR_CLIENT_SECRET: {
                type: "json",
                value: configured ? "test-linear-secret" : "",
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
    const identity = { subject, issuer: "https://identity.example.test" };

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
      missing: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain("/auth/callback/linear");
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });
  it("lists and calls every Linear tool and isolates users and identity issuers", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connection_required",
    });
    await connect(alice, "alice");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
      accountId: "user-alice",
    });
    expect(await (await alice.request("/rpc/personal/status")).json()).toMatchObject({
      account: { id: "user-alice", label: "alice@example.test" },
    });
    expect(await (await alice.request("/rpc/tools")).json()).toEqual({
      status: "connected",
      tools: [
        {
          name: "list_issues",
          title: "List issues",
          description: "List issues in the user's Linear workspace.",
          inputSchema: '{"type":"object","properties":{"assignee":{"type":"string"}}}',
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: "save_issue",
          description: "Create or update an issue.",
          inputSchema: '{"type":"object","properties":{"title":{"type":"string"}}}',
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
      ],
    });

    const listed = z
      .object({ status: z.literal("connected"), text: z.string() })
      .parse(await (await alice.request("/rpc/list")).json());

    expect(JSON.parse(listed.text)).toMatchObject({
      issues: [{ id: "ENG-1", title: "Synthetic issue" }],
      hasNextPage: false,
    });

    const created = z
      .object({ status: z.literal("connected"), text: z.string() })
      .parse(await (await alice.request("/rpc/create")).json());

    expect(JSON.parse(created.text)).toMatchObject({ id: "ENG-2", title: "From Widefleet" });

    // Parts other than text stay as the server sent them.
    expect(await (await alice.request("/rpc/image")).json()).toEqual({
      status: "connected",
      text: "",
      content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
    expect(upstream.calls).toEqual([
      { name: "list_issues", arguments: { assignee: "me" } },
      { name: "save_issue", arguments: { title: "From Widefleet", team: "ENG", labels: ["bug"] } },
      { name: "extract_images", arguments: { markdown: "![](x)" } },
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
  it("refreshes expiring tokens, preserves accounts on outages and disconnects only the current user", async () => {
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
  it("reports Linear's tool errors, rate limits and revoked tokens", async () => {
    const alice = browser("alice");
    await connect(alice, "alice");
    upstream.state.toolError =
      '{"error":"invalid_request","message":"Could not find referenced Issue."}';
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "linear_error",
      message: '{"error":"invalid_request","message":"Could not find referenced Issue."}',
    });
    upstream.state.toolError = "";
    expect(await (await alice.request("/rpc/unknown")).json()).toEqual({
      status: "linear_error",
      message: "Tool delete_everything not found",
    });
    upstream.state.apiStatus = 429;
    upstream.state.apiHeaders.set("retry-after", "30");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "30",
    });
    upstream.state.apiStatus = 403;
    expect(await (await alice.request("/rpc/list")).json()).toEqual({ status: "access_denied" });
    upstream.state.apiStatus = 401;
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "reconnect_required",
    });
    upstream.state.apiStatus = 502;
    expect((await alice.request("/rpc/list")).status).toBe(500);
  });
});
