import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provider } from "./provider.ts";

describe("Google Drive personal account app", () => {
  const origin = "https://google.example.test:25453";
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
              GOOGLE_CLIENT_ID: {
                type: "json",
                value: configured ? "test-google-client" : "",
              },
              GOOGLE_CLIENT_SECRET: {
                type: "json",
                value: configured ? "test-google-secret" : "",
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
      missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain("/auth/callback/google");
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });
  it("links, sends typed requests with field selections and isolates users and issuers", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connection_required",
    });
    await connect(alice, "101");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "connected",
      data: { files: [{ id: "file-101", name: "report.txt" }] },
    });
    expect(await (await alice.request("/rpc/file?id=abc")).json()).toEqual({
      status: "connected",
      data: { id: "abc", name: "report.txt", mimeType: "text/plain" },
    });
    // Content is read with alt=media; exports return it directly.
    expect(await (await alice.request("/rpc/content")).json()).toEqual({
      contentType: "text/plain",
      text: "File content",
    });
    expect(await (await alice.request("/rpc/export")).json()).toEqual({
      contentType: "text/plain",
      text: "Exported text",
    });
    // The selection becomes Google's fields parameter; undefined arguments are left out.
    expect(upstream.calls.map(({ method, url }) => [method, decodeURIComponent(url)])).toEqual([
      [
        "GET",
        "https://www.googleapis.com/drive/v3/files?pageSize=5&q=name+contains+'report'&fields=files(id,name),nextPageToken",
      ],
      ["GET", "https://www.googleapis.com/drive/v3/files/abc?fields=id,name,mimeType"],
      ["GET", "https://www.googleapis.com/drive/v3/files/file-1?alt=media"],
      ["GET", "https://www.googleapis.com/drive/v3/files/doc-1/export?mimeType=text/plain"],
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

    expect(saved.accessToken).not.toContain("synthetic-access-");
    // Encrypted through the app key binding, not with an app-held secret.
    expect(saved.accessToken).toMatch(/^v1\./);
    expect(saved.refreshToken).not.toContain("synthetic-refresh-");
  });

  it("uploads content and asks before sharing, replacing and deleting as each user's approval level says", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.calls.length = 0;

    // By default, creating a file with its content runs at once, as one multipart upload.
    expect(await (await alice.request("/rpc/upload")).json()).toEqual({
      status: "connected",
      data: { id: "uploaded", name: "notes.txt" },
    });

    const upload = upstream.calls[0];

    expect(upload?.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files?fields=id%2Cname&uploadType=multipart",
    );

    const parts = z
      .string()
      .parse(upload?.body)
      .split(/\r\n--widefleet-[\w-]+(?:--)?\r?\n?/);

    expect(parts.join("|")).toContain(
      'Content-Type: application/json; charset=UTF-8\r\n\r\n{"name":"notes.txt"}',
    );
    expect(parts.join("|")).toContain("Content-Type: text/plain\r\n\r\nHello");
    // Content needs text or base64; a request without either never reaches Google.
    expect((await alice.request("/rpc/bad-upload")).status).toBe(500);
    expect(upstream.calls).toHaveLength(1);

    // Sharing with a person emails them and asks first.
    const asked = z
      .object({ inputRequests: z.object({ approve: z.object({ message: z.string() }) }) })
      .parse(await (await alice.request("/rpc/share")).json());

    expect(asked.inputRequests.approve.message).toContain(
      'Run the Google Drive change "permissionsCreate"? It sends something to other people.',
    );
    expect(await (await alice.request("/rpc/replace")).json()).toMatchObject({
      resultType: "input_required",
    });
    expect(upstream.calls).toHaveLength(1);

    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/share")).json()).toEqual({ status: "declined" });
    expect(upstream.calls).toHaveLength(1);

    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/share")).json()).toEqual({
      status: "connected",
      data: { id: "permission-1" },
    });
    expect(await (await alice.request("/rpc/replace")).json()).toEqual({
      status: "connected",
      data: { id: "file-1" },
    });
    expect(z.string().parse(upstream.calls.at(-1)?.body)).toContain(
      "Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC",
    );
    expect(await (await alice.request("/rpc/delete")).json()).toEqual({
      status: "connected",
      data: null,
    });

    // Asking more takes effect at once; then uploading asks too.
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/set-level?level=all_changes")).json()).toEqual({
      status: "updated",
      level: "all_changes",
    });
    expect(await (await alice.request("/rpc/upload")).json()).toMatchObject({
      resultType: "input_required",
    });

    // At level none, nothing asks.
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toMatchObject({
      resultType: "input_required",
    });
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toEqual({
      status: "updated",
      level: "none",
    });
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/share")).json()).toMatchObject({ status: "connected" });
    expect(await (await alice.request("/")).text()).toContain('value="none" checked');
  });

  it("reports Google Drive's errors, rate limits, missing scopes and revoked tokens", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    // Larger responses are not read.
    upstream.state.answer = {
      status: 200,
      body: { id: "big", name: "x".repeat(9 * 1024 * 1024) },
      headers: {},
    };
    expect(await (await alice.request("/rpc/file?id=big")).json()).toEqual({
      status: "too_large",
      maximumBytes: 8 * 1024 * 1024,
    });
    upstream.state.answer = {
      status: 404,
      body: {
        error: {
          code: 404,
          message: "Not Found",
          status: "NOT_FOUND",
          errors: [{ reason: "notFound" }],
        },
      },
      headers: {},
    };
    expect(await (await alice.request("/rpc/file?id=missing")).json()).toEqual({
      status: "drive_error",
      error: { message: "Not Found", code: 404, status: "NOT_FOUND", reasons: ["notFound"] },
    });
    upstream.state.answer = {
      status: 403,
      body: {
        error: { code: 403, message: "Quota", errors: [{ reason: "rateLimitExceeded" }] },
      },
      headers: { "retry-after": "20" },
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "20",
    });
    upstream.state.answer = {
      status: 403,
      body: {
        error: { code: 403, message: "Scopes", errors: [{ reason: "insufficientPermissions" }] },
      },
      headers: {},
    };
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "permission_required",
    });
    upstream.state.answer = { status: 401, body: null, headers: {} };
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "reconnect_required",
    });
    upstream.state.answer = { status: 502, body: null, headers: {} };
    expect((await alice.request("/rpc/list")).status).toBe(500);
  });

  it("asks users who granted fewer scopes to reconnect", async () => {
    upstream.state.scope = "openid profile email https://www.googleapis.com/auth/drive.readonly";
    const alice = browser("alice");
    await connect(alice, "101");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "permission_required",
    });
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "permission_required",
    });
    // A change does not ask first when the account could not run it.
    expect(await (await alice.request("/rpc/delete")).json()).toMatchObject({
      status: "permission_required",
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
});
