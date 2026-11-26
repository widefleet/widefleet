import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provider } from "./provider.ts";

describe("OneDrive personal account app", () => {
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

    const address = destination.replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    );

    // People with several Microsoft accounts choose the one to connect.
    expect(new URL(address).searchParams.get("prompt")).toBe("select_account");

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
        value: [
          {
            id: "file-101",
            name: "report.txt",
            size: 12,
            file: { mimeType: "text/plain" },
            parentReference: { driveId: "drive-1", id: "root" },
          },
        ],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/drives/drive-1/items/root/children?$skiptoken=page-2",
      },
    });
    // Path parameters fill the path; OData lists are joined with commas.
    expect(upstream.calls.map((call) => call.url)).toEqual([
      "https://graph.microsoft.com/v1.0/drives/drive-1/items/root/children?%24top=5&%24select=id%2Cname",
    ]);

    // A later page is read at the address Graph gave.
    const next =
      "https://graph.microsoft.com/v1.0/drives/drive-1/items/root/children?$skiptoken=page-2";

    expect(
      await (await alice.request(`/rpc/next?link=${encodeURIComponent(next)}`)).json(),
    ).toMatchObject({ status: "connected", data: { value: [{ id: "file-2" }] } });
    expect(upstream.calls.at(-1)?.url).toBe(next);
    // File content is the temporary download address, which the app never fetches.
    expect(await (await alice.request("/rpc/content")).json()).toEqual({
      status: "connected",
      data: { downloadUrl: "https://download.example.test/file?token=synthetic" },
    });
    expect(upstream.state.downloads).toBe(0);
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
    await connect(alice, "101");
    upstream.calls.length = 0;

    // By default, creating runs at once; replacing content and deleting ask first.
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      status: "connected",
      data: { id: "folder-1", name: "Reports" },
    });
    expect(upstream.calls[0]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "Reports", folder: {} }),
      type: "application/json",
    });
    expect(await (await alice.request("/rpc/delete")).json()).toEqual({
      resultType: "input_required",
      inputRequests: {
        approve: {
          message: `Run the OneDrive change "deleteItem"? It deletes or replaces data.\n\nInput:\n${JSON.stringify({ driveId: "drive-1", driveItemId: "file-1" }, null, 2)}`,
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });
    expect(await (await alice.request("/rpc/upload")).json()).toMatchObject({
      resultType: "input_required",
    });
    expect(upstream.calls).toHaveLength(1);

    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/delete")).json()).toEqual({ status: "declined" });
    expect(upstream.calls).toHaveLength(1);

    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/delete")).json()).toEqual({
      status: "connected",
      data: null,
    });
    expect(await (await alice.request("/rpc/upload")).json()).toMatchObject({
      status: "connected",
      data: { id: "file-1" },
    });
    expect(upstream.calls.slice(1)).toEqual([
      {
        method: "DELETE",
        url: "https://graph.microsoft.com/v1.0/drives/drive-1/items/file-1",
        body: null,
        type: null,
      },
      {
        method: "PUT",
        url: "https://graph.microsoft.com/v1.0/drives/drive-1/items/file-1/content",
        body: "new content",
        type: "text/plain",
      },
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
    await connect(bob, "102");
    expect(await (await bob.request("/rpc/create")).json()).toMatchObject({ status: "connected" });
  });

  it("lets users choose their approval level on the app's page", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
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

  it("asks users who granted fewer scopes to reconnect", async () => {
    upstream.state.scope = "openid profile email offline_access User.Read Files.Read";
    const alice = browser("alice");
    await connect(alice, "101");

    for (const path of ["/rpc/list", "/rpc/status", "/rpc/delete"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        status: "permission_required",
      });
    expect(upstream.calls).toEqual([]);
    // Microsoft may name Graph's scopes with their resource prefix.
    upstream.state.scope = "openid profile email https://graph.microsoft.com/Files.ReadWrite.All";
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
