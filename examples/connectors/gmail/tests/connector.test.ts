import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provider } from "./provider.ts";

const origin = "https://gmail.example.test";

describe("Gmail connector with Better Auth and D1", () => {
  let runtime: Miniflare;
  let google: ReturnType<typeof provider>;
  let script: string;

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

        for (const header of response.headers.getSetCookie()) {
          const value = header.split(";")[0] ?? "";
          cookies.set(value.split("=")[0] ?? "", value);
        }

        return response;
      },
    };
  };

  const start = async (client: ReturnType<typeof browser>) => {
    const response = await client.request("/connect", "POST");
    const page = await response.text();
    expect(response.status, page).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    const destination = z.string().parse(/<a href="([^"]+)">/.exec(page)?.[1]);
    expect(page).toContain(`<meta http-equiv="refresh" content="0;url=${destination}">`);

    return destination.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
  };

  const connect = async (client: ReturnType<typeof browser>, user: string) => {
    const response = await client.request(google.authorize(await start(client), user));
    expect(response.status, await response.clone().text()).toBe(302);
    expect(response.headers.get("location")).toBe(`${origin}/`);
  };

  const expire = async () => {
    const db = await runtime.getD1Database("DB");
    await db
      .prepare("UPDATE account SET accessTokenExpiresAt = ?")
      .bind(Date.now() - 60_000)
      .run();
  };

  beforeAll(async () => {
    const bundled = await build({
      entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url).href)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["cloudflare:*", "node:*"],
    });

    script = z.string().parse(bundled.outputFiles[0]?.text);
  });

  const configuration = () =>
    ({
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: "gmail-test",
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: script } },
            },
            env: {
              DB: { type: "d1", id: "gmail-test-db" },
              WIDEFLEET_ORIGIN: { type: "json", value: origin },
              GOOGLE_CLIENT_ID: { type: "json", value: "test-google-client" },
              GOOGLE_CLIENT_SECRET: { type: "json", value: "test-google-secret" },
              AUTH_SECRET: {
                type: "json",
                value: "synthetic-test-secret-with-at-least-32-characters",
              },
            },
          },
          dev: { outboundService: { type: "fetcher", handler: google.fetch } },
        },
      ],
    }) satisfies MiniflareOptions;

  beforeEach(async () => {
    google = provider();
    runtime = new Miniflare(configuration());
    await runtime.ready;
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  it("links the caller, reuses the connection across requests, and isolates subjects and issuers", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    expect(await (await alice.request("/rpc/messages")).json()).toEqual({
      status: "connection_required",
    });
    await connect(alice, "google-alice");
    expect(await (await alice.request("/")).text()).toContain("google-alice@example.test");
    expect(await (await alice.request("/rpc/messages")).json()).toEqual({
      status: "connected",
      messages: [{ id: "message-google-alice", threadId: "thread-1" }],
      nextPageToken: "page-2",
    });
    expect(await (await browser("alice").request("/rpc/status")).json()).toEqual({
      connected: true,
      googleAccountId: "google-alice",
    });
    expect(await (await bob.request("/rpc/status")).json()).toEqual({
      connected: false,
      googleAccountId: null,
    });
    await connect(bob, "google-bob");
    expect(await (await bob.request("/rpc/message")).json()).toMatchObject({
      status: "connected",
      message: { payload: { headers: [{ name: "Subject", value: "Hello google-bob" }] } },
    });
    alice.identity.issuer = "https://other-identity.example.test";
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({ connected: false });
  });

  it("encrypts saved credentials and keeps Better Auth's token and session endpoints private", async () => {
    const alice = browser("alice");
    await connect(alice, "google-alice");
    const db = await runtime.getD1Database("DB");
    const rows = await db.prepare("SELECT accessToken, refreshToken FROM account").all();

    const accounts = z
      .array(z.object({ accessToken: z.string(), refreshToken: z.string() }))
      .parse(rows.results);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.accessToken).not.toContain("synthetic-access-");
    expect(accounts[0]?.refreshToken).not.toContain("synthetic-refresh-");

    for (const path of [
      "get-access-token",
      "refresh-token",
      "widefleet-session",
      "link-social",
      "sign-in/social",
    ])
      expect((await alice.request(`/auth/${path}`, "POST")).status).toBe(404);
    expect((await alice.request("/auth/get-session")).status).toBe(404);
    expect(
      (await runtime.dispatchFetch(origin, { headers: { "x-auth-request-user": "alice" } })).status,
    ).toBe(401);
  });

  it("preserves the connection when worker code reloads", async () => {
    const alice = browser("alice");
    await connect(alice, "google-alice");
    script += "\n// Worker reload fixture\n";
    await runtime.setOptions(configuration());
    expect(await (await browser("alice").request("/rpc/messages")).json()).toMatchObject({
      status: "connected",
    });
  });

  it("reports missing Gmail permission without calling Gmail", async () => {
    const alice = browser("alice");
    await connect(alice, "google-alice");
    const db = await runtime.getD1Database("DB");
    await db.prepare("UPDATE account SET scope = 'profile'").run();
    expect(await (await alice.request("/rpc/messages")).json()).toEqual({
      status: "permission_required",
    });
  });

  it("rejects cross-origin actions, changed callback users, missing state cookies and replay", async () => {
    const alice = browser("alice");
    expect((await alice.request("/connect", "POST", "https://app.example.test")).status).toBe(403);
    expect((await alice.request("/disconnect", "POST", "https://app.example.test")).status).toBe(
      403,
    );
    const callback = google.authorize(await start(alice), "google-alice");
    expect((await browser("alice").request(callback)).status).toBe(403);
    alice.identity.subject = "bob";
    expect((await alice.request(callback)).status).toBe(403);
    alice.identity.subject = "alice";
    expect((await alice.request(callback)).headers.get("location")).toBe(`${origin}/`);
    expect((await alice.request(callback)).headers.get("location")).not.toBe(`${origin}/`);
  });

  it("refreshes expired tokens and reports both revoked consent and outages without deleting accounts", async () => {
    const alice = browser("alice");
    await connect(alice, "google-alice");
    await expire();
    expect(await (await alice.request("/rpc/messages")).json()).toMatchObject({
      status: "connected",
    });
    expect(google.state.refreshes).toBe(1);
    await expire();
    google.state.unavailable = true;
    expect(await (await alice.request("/rpc/messages")).json()).toEqual({
      status: "refresh_failed",
    });
    google.state.unavailable = false;
    google.state.revoked = true;
    expect(await (await alice.request("/rpc/messages")).json()).toEqual({
      status: "refresh_failed",
    });
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({ connected: true });
    google.state.revoked = false;
    await connect(alice, "google-alice");
    expect(await (await alice.request("/rpc/messages")).json()).toMatchObject({
      status: "connected",
    });
    google.state.apiStatus = 401;
    expect(await (await alice.request("/rpc/messages")).json()).toEqual({
      status: "reconnect_required",
    });
    google.state.apiStatus = 403;
    expect(await (await alice.request("/rpc/messages")).json()).toEqual({
      status: "access_denied",
    });
  });

  it("rejects linking another user's Google account and preserves the current account on a switch attempt", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    await connect(alice, "google-alice");
    const conflict = await bob.request(google.authorize(await start(bob), "google-alice"));
    expect(conflict.headers.get("location")).toContain("error=");
    expect(await (await bob.request("/rpc/status")).json()).toMatchObject({ connected: false });
    const switchAttempt = await alice.request(google.authorize(await start(alice), "google-other"));
    expect(switchAttempt.status).toBe(302);
    expect(switchAttempt.headers.get("location")).toContain("disconnect_before_switching_accounts");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      googleAccountId: "google-alice",
    });
  });

  it("disconnects only this caller and invalidates an outstanding linking session", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    await connect(alice, "google-alice");
    await connect(bob, "google-bob");
    const pending = google.authorize(await start(alice), "google-alice");
    expect((await alice.request("/disconnect", "POST")).status).toBe(303);
    expect(await (await alice.request("/rpc/messages")).json()).toEqual({
      status: "connection_required",
    });
    expect((await alice.request(pending)).status).toBe(403);
    expect(await (await bob.request("/rpc/status")).json()).toMatchObject({ connected: true });
  });
});
