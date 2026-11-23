import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provider } from "./provider.ts";

describe("WHOOP personal account app", () => {
  const origin = "https://whoop.example.test:25453";
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
              WHOOP_CLIENT_ID: { type: "json", value: configured ? "test-whoop-client" : "" },
              WHOOP_CLIENT_SECRET: { type: "json", value: configured ? "test-whoop-secret" : "" },
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

  it("shows the WHOOP app to register before setup without attempting OAuth", async () => {
    await runtime.setOptions(configuration(false));
    const alice = browser("alice");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "setup_required",
      missing: ["WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain(`${origin}/auth/callback/whoop`);
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });

  it("connects members with the organization's app and isolates users and identity issuers", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    expect(await (await alice.request("/rpc/cycles")).json()).toMatchObject({
      status: "connection_required",
    });
    await connect(alice, "10129");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
      accountId: "10129",
    });
    expect(await (await alice.request("/rpc/personal/status")).json()).toEqual({
      setup: "ready",
      connection: "connected",
      account: { id: "10129", label: "member10129@example.test" },
    });
    upstream.calls.length = 0;
    expect(await (await alice.request("/rpc/cycles")).json()).toMatchObject({
      status: "connected",
      data: { records: [{ id: 93845, user_id: 10129 }], next_token: "page-2" },
    });
    expect(upstream.calls.map((call) => call.url)).toEqual([
      "https://api.prod.whoop.com/developer/v2/cycle?limit=1&start=2026-11-01T00%3A00%3A00.000Z",
    ]);
    // A later page continues at the earlier answer's `next_token`.
    expect(await (await alice.request("/rpc/next?token=page-2")).json()).toEqual({
      status: "connected",
      data: { records: [expect.objectContaining({ id: 93844 })] },
    });
    expect(await (await alice.request("/rpc/recovery")).json()).toMatchObject({
      status: "connected",
      data: { cycle_id: 93845, score: { recovery_score: 44 } },
    });
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

  it("asks before revoking access and runs it only after approval", async () => {
    const alice = browser("alice");
    await connect(alice, "10129");
    upstream.calls.length = 0;

    expect(await (await alice.request("/rpc/revoke")).json()).toEqual({
      resultType: "input_required",
      inputRequests: {
        approve: {
          message: `Run the WHOOP change "revokeAccess"? It deletes or replaces data.\n\nInput:\n${JSON.stringify({}, null, 2)}`,
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });
    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/revoke")).json()).toEqual({ status: "declined" });
    expect(upstream.calls).toEqual([]);

    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/revoke")).json()).toEqual({
      status: "connected",
      data: null,
    });
    expect(upstream.calls).toEqual([
      { method: "DELETE", url: "https://api.prod.whoop.com/developer/v2/user/access" },
    ]);
    // WHOOP rejects the saved tokens afterwards; the member reconnects.
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/profile")).json()).toMatchObject({
      status: "reconnect_required",
    });

    // With approvals off, nothing asks.
    const bob = browser("bob");
    await connect(bob, "10130");
    bob.identity.answer = "accept";
    expect(await (await bob.request("/rpc/set-level?level=none")).json()).toEqual({
      status: "updated",
      level: "none",
    });
    bob.identity.answer = "";
    expect(await (await bob.request("/rpc/revoke")).json()).toEqual({
      status: "connected",
      data: null,
    });
  });

  it("lets users choose their approval level on the app's page", async () => {
    const alice = browser("alice");
    await connect(alice, "10129");
    const page = await (await alice.request("/")).text();
    expect(page).toContain("Your account <code>member10129@example.test</code> is linked.");
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
  });

  it("asks members who granted fewer scopes to reconnect", async () => {
    upstream.state.scope = "offline read:profile read:cycles";
    const alice = browser("alice");
    await connect(alice, "10129");
    upstream.calls.length = 0;

    for (const path of ["/rpc/cycles", "/rpc/status", "/rpc/revoke"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        status: "permission_required",
      });
    expect(upstream.calls).toEqual([]);
    upstream.state.scope =
      "offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout";
    await connect(alice, "10129");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
  });

  it("rejects changed callback identities, replay, cross-origin forms and public token endpoints", async () => {
    const alice = browser("alice");
    expect((await alice.request("/connect", "POST", "null")).status).toBe(403);
    const callback = upstream.authorize(await start(alice), "10129");
    expect((await browser("alice").request(callback)).status).toBe(403);
    alice.identity.subject = "bob";
    expect((await alice.request(callback)).status).toBe(403);
    alice.identity.subject = "alice";
    expect((await alice.request(callback)).headers.get("location")).toBe(`${origin}/`);
    expect((await alice.request(callback)).headers.get("location")).not.toBe(`${origin}/`);

    // Switching members needs a disconnect first.
    const other = upstream.authorize(await start(alice), "999");
    expect((await alice.request(other)).headers.get("location")).toContain("error=");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      accountId: "10129",
    });

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

  it("refreshes rotating tokens with the offline scope, preserves accounts on outages and disconnects only the current user", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    await connect(alice, "10129");
    await connect(bob, "10130");
    const db = await runtime.getD1Database("DB");

    const expire = async () => {
      await db
        .prepare("UPDATE account SET accessTokenExpiresAt = ?")
        .bind(Date.now() - 60000)
        .run();
    };

    // Each refresh uses the refresh token the previous one returned.
    for (const refreshes of [1, 2]) {
      await expire();
      expect(await (await alice.request("/rpc/profile")).json()).toMatchObject({
        status: "connected",
        data: { user_id: 10129 },
      });
      expect(upstream.state.refreshes).toBe(refreshes);
    }

    await expire();
    upstream.state.unavailable = true;
    expect(await (await alice.request("/rpc/profile")).json()).toMatchObject({
      status: "refresh_failed",
    });
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
    upstream.state.unavailable = false;
    const pending = upstream.authorize(await start(alice), "10129");
    expect((await alice.request("/disconnect", "POST")).status).toBe(303);
    expect((await alice.request(pending)).status).toBe(403);
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
    expect(await (await bob.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
  });

  it("reports WHOOP's errors, rate limits and revoked tokens", async () => {
    const alice = browser("alice");
    await connect(alice, "10129");
    upstream.state.answer = { status: 404, body: { message: "Not found" }, headers: {} };
    expect(await (await alice.request("/rpc/recovery?cycle=1")).json()).toEqual({
      status: "whoop_error",
      error: { status: 404, body: { message: "Not found" } },
    });
    upstream.state.answer = { status: 400, body: null, headers: {} };
    expect(await (await alice.request("/rpc/cycles")).json()).toEqual({
      status: "whoop_error",
      error: { status: 400, body: null },
    });
    upstream.state.answer = { status: 429, body: null, headers: { "retry-after": "60" } };
    expect(await (await alice.request("/rpc/cycles")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "60",
    });
    // Larger responses are not read.
    upstream.state.answer = {
      status: 200,
      body: { records: [{ id: 1, note: "x".repeat(9 * 1024 * 1024) }] },
      headers: {},
    };
    expect(await (await alice.request("/rpc/cycles")).json()).toEqual({
      status: "too_large",
      maximumBytes: 8 * 1024 * 1024,
    });
    upstream.state.answer = { status: 500, body: null, headers: {} };
    expect((await alice.request("/rpc/cycles")).status).toBe(500);
    // Requests that do not match the operation never reach WHOOP.
    upstream.calls.length = 0;
    expect((await alice.request("/rpc/invalid")).status).toBe(500);
    expect(upstream.calls).toEqual([]);
    upstream.state.answer = { status: 401, body: null, headers: {} };
    expect(await (await alice.request("/rpc/cycles")).json()).toMatchObject({
      status: "reconnect_required",
    });
  });
});
