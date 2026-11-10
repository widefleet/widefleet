import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provider } from "./provider.ts";

describe("GitHub personal account app", () => {
  const origin = "https://github.example.test:25453";
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
              GITHUB_CLIENT_ID: {
                type: "json",
                value: configured ? "test-github-client" : "",
              },
              GITHUB_CLIENT_SECRET: {
                type: "json",
                value: configured ? "test-github-secret" : "",
              },
              AUTH_SECRET: {
                type: "json",
                value: configured ? "synthetic-secret-with-at-least-32-characters" : "",
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
      missing: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "AUTH_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain("/auth/callback/github");
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });
  it("uses non-expiring OAuth tokens for repeated reads and isolates users and identity issuers", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connection_required",
    });
    await connect(alice, "101");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connected",
    });
    const download = await alice.request("/rpc/content");
    const downloaded = await download.text();
    expect(download.status, downloaded).toBe(200);
    const content: object = z.object().passthrough().parse(JSON.parse(downloaded));
    expect(content).toMatchObject({ status: "connected" });
    expect(await (await bob.request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
    alice.identity.issuer = "https://other-identity.example.test";
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
    const db = await runtime.getD1Database("DB");

    const saved = z
      .object({
        accessToken: z.string(),
        refreshToken: z.null(),
        accessTokenExpiresAt: z.null(),
        idToken: z.null(),
      })
      .parse(
        await db
          .prepare("SELECT accessToken, refreshToken, accessTokenExpiresAt, idToken FROM account")
          .first(),
      );

    expect(saved.accessToken).not.toContain("synthetic-access-");
    expect(upstream.state.refreshes).toBe(0);
    alice.identity.issuer = "https://identity.example.test";
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({ status: "connected" });
    expect(upstream.state.refreshes).toBe(0);
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
    upstream.state.expiringTokens = true;
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
  it.each([301, 302, 303, 307, 308])(
    "reads files and issues after a %s repository redirect",
    async (status) => {
      const alice = browser("alice");
      await connect(alice, "101");
      upstream.requests.length = 0;
      upstream.state.redirects.set(
        "https://api.github.com/repos/example/project/contents/README.md",
        { status, location: "https://api.github.com/repositories/42/contents/README.md" },
      );
      upstream.state.redirects.set(
        "https://api.github.com/repos/example/project/issues?page=1&per_page=30&state=open",
        { status, location: "/repositories/42/issues?page=1&per_page=30&state=open" },
      );

      expect(await (await alice.request("/rpc/content")).json()).toEqual({
        status: "connected",
        data: Object.fromEntries(new TextEncoder().encode("file content").entries()),
        contentType: "text/plain",
      });
      expect(await (await alice.request("/rpc/issues")).json()).toMatchObject({
        status: "connected",
        issues: [{ number: 7, title: "Open issue" }],
        nextPage: 2,
      });
      expect(upstream.requests).toHaveLength(4);

      for (const request of upstream.requests)
        expect(request.headers.get("authorization")).toBe(
          upstream.requests[0]?.headers.get("authorization"),
        );
      expect(upstream.requests[1]?.headers.get("accept")).toBe("application/vnd.github.raw+json");
      expect(upstream.requests[3]?.headers.get("accept")).toBe("application/vnd.github+json");
    },
  );
  it.each([
    "https://other.example.test/file",
    "https://api.github.com.other.example.test/file",
    "http://api.github.com/file",
    "https://name:password@api.github.com/file",
  ])("rejects a redirect to %s before forwarding the token", async (location) => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.requests.length = 0;
    upstream.state.apiStatus = 302;
    upstream.state.apiHeaders.set("location", location);
    expect((await alice.request("/rpc/content")).status).toBe(500);
    expect(upstream.requests).toHaveLength(1);
  });
  it("bounds redirect loops and rejects a redirect without a location", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.requests.length = 0;
    upstream.state.apiStatus = 301;
    upstream.state.apiHeaders.set(
      "location",
      "https://api.github.com/repos/example/project/contents/README.md",
    );
    expect((await alice.request("/rpc/content")).status).toBe(500);
    expect(upstream.requests).toHaveLength(6);
    upstream.requests.length = 0;
    upstream.state.apiHeaders.delete("location");
    expect((await alice.request("/rpc/content")).status).toBe(500);
    expect(upstream.requests).toHaveLength(1);
  });
  it("distinguishes rate limits from authorization failures and preserves the retry delay", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.state.apiStatus = 403;
    expect(await (await alice.request("/rpc/list")).json()).toEqual({ status: "access_denied" });
    upstream.state.apiHeaders.set("retry-after", "60");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "60",
    });
    upstream.state.apiStatus = 429;
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "60",
    });
    upstream.state.apiStatus = 403;
    upstream.state.apiHeaders.delete("retry-after");
    upstream.state.apiHeaders.set("x-ratelimit-remaining", "0");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: null,
    });
    upstream.state.apiHeaders.set("x-ratelimit-reset", String(Math.ceil(Date.now() / 1000) + 3600));

    const limited = z
      .object({ status: z.literal("rate_limited"), retryAfter: z.string() })
      .parse(await (await alice.request("/rpc/list")).json());

    expect(Number(limited.retryAfter)).toBeGreaterThan(3590);
    expect(Number(limited.retryAfter)).toBeLessThanOrEqual(3601);
    upstream.state.apiHeaders.set("x-ratelimit-remaining", "10");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({ status: "access_denied" });
    upstream.state.apiStatus = 401;
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "reconnect_required",
    });
  });
});
