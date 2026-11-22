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
      missing: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain("/auth/callback/linear");
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });
  it("sends typed requests through generated methods and isolates users and identity issuers", async () => {
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
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "connected",
      data: { nodes: [{ identifier: "ENG-1", title: "Synthetic issue" }] },
    });
    // Arguments travel as variables with the types Linear's schema declares.
    expect(upstream.calls).toEqual([
      {
        query: "query($v0: Int) { issues(first: $v0) { nodes { identifier title } } }",
        variables: { v0: 5 },
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
    await connect(alice, "alice");
    upstream.calls.length = 0;

    // By default, creating runs at once; deleting asks first.
    expect(await (await alice.request("/rpc/level")).json()).toEqual({
      status: "signed_in",
      level: "updates_and_deletions",
    });
    expect(await (await alice.request("/rpc/create")).json()).toEqual({
      status: "connected",
      data: { success: true, issue: { identifier: "ENG-2" } },
    });
    expect(await (await alice.request("/rpc/delete?id=ENG-1")).json()).toEqual({
      resultType: "input_required",
      inputRequests: {
        approve: {
          message: `Run the Linear change "issueDelete"? It deletes or replaces data.\n\nInput:\n${JSON.stringify({ id: "ENG-1" }, null, 2)}`,
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });
    expect(upstream.calls).toHaveLength(1);

    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/delete?id=ENG-1")).json()).toEqual({
      status: "declined",
    });
    expect(upstream.calls).toHaveLength(1);

    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/delete?id=ENG-1")).json()).toEqual({
      status: "connected",
      data: { success: true },
    });
    expect(upstream.calls[1]).toEqual({
      query: "mutation($v0: String!) { issueDelete(id: $v0) { success } }",
      variables: { v0: "ENG-1" },
    });

    // Asking more takes effect at once; then creating asks too.
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/set-level?level=all_changes")).json()).toEqual({
      status: "updated",
      level: "all_changes",
    });
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      resultType: "input_required",
    });

    // Asking less needs the user's confirmation.
    const loosening = z
      .object({ inputRequests: z.object({ approve: z.object({ message: z.string() }) }) })
      .parse(await (await alice.request("/rpc/set-level?level=none")).json());

    expect(loosening.inputRequests.approve.message).toContain("New: Never ask");
    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toEqual({
      status: "declined",
    });
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toEqual({
      status: "updated",
      level: "none",
    });
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/delete?id=ENG-1")).json()).toMatchObject({
      status: "connected",
    });

    // Each user has their own level.
    const bob = browser("bob");
    await connect(bob, "bob");
    expect(await (await bob.request("/rpc/delete?id=ENG-1")).json()).toMatchObject({
      resultType: "input_required",
    });

    // Long input is shortened for review and fits Widefleet's question limit.
    const asked = z
      .object({ inputRequests: z.object({ approve: z.object({ message: z.string() }) }) })
      .parse(await (await bob.request(`/rpc/delete?id=${"x".repeat(5000)}`)).json());

    expect(asked.inputRequests.approve.message.length).toBeLessThanOrEqual(4096);
    expect(asked.inputRequests.approve.message).toContain("(5000 characters)");
    expect(asked.inputRequests.approve.message).toContain(
      "Approving runs the change with the complete input",
    );
  });

  it("lets users choose their approval level on the app's page", async () => {
    const alice = browser("alice");
    await connect(alice, "alice");
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
  it("reports Linear's errors, rate limits and revoked tokens", async () => {
    const alice = browser("alice");
    await connect(alice, "alice");
    upstream.state.errors = [
      {
        message: "Entity not found: Issue",
        path: ["issues"],
        extensions: { type: "invalid input", userPresentableMessage: "Could not find the issue." },
      },
    ];
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "linear_error",
      errors: [{ message: "Could not find the issue.", type: "invalid input", path: ["issues"] }],
    });
    upstream.state.errors = [{ message: "Rate limited", extensions: { type: "ratelimited" } }];
    upstream.state.apiHeaders.set("retry-after", "30");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "30",
    });
    upstream.state.errors = [];
    // Requests that do not match Linear's schema never reach Linear.
    upstream.calls.length = 0;
    expect((await alice.request("/rpc/invalid")).status).toBe(500);
    expect(upstream.calls).toEqual([]);
    upstream.state.apiStatus = 429;
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
    upstream.state.apiStatus = 200;
    // Linear reports a revoked token as a GraphQL authentication error.
    upstream.revokeAccess();
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "reconnect_required",
    });
  });
});
