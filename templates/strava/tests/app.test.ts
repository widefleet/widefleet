import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provider } from "./provider.ts";

describe("Strava personal account app", () => {
  const origin = "https://strava.example.test:25453";
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
              STRAVA_CLIENT_ID: { type: "json", value: configured ? "test-strava-client" : "" },
              STRAVA_CLIENT_SECRET: { type: "json", value: configured ? "test-strava-secret" : "" },
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
      request: async (path: string, method = "GET", requestOrigin = origin, body?: string) => {
        const response = await runtime.dispatchFetch(new URL(path, origin).href, {
          method,
          redirect: "manual",
          body: body ?? null,
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

  const connect = async (client: ReturnType<typeof browser>, user: string, granted?: string) => {
    const response = await client.request(upstream.authorize(await start(client), user, granted));
    expect(response.headers.get("location"), await response.text()).toBe(`${origin}/`);
  };

  it("shows the Strava application to register before setup without attempting OAuth", async () => {
    await runtime.setOptions(configuration(false));
    const alice = browser("alice");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "setup_required",
      missing: ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain(
      'Authorization Callback Domain to <code class="value">strava.example.test</code>',
    );
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });

  it("connects athletes with the organization's application and isolates users and identity issuers", async () => {
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
    expect(await (await alice.request("/rpc/personal/status")).json()).toEqual({
      setup: "ready",
      connection: "connected",
      account: { id: "101", label: "athlete101" },
    });
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "connected",
      data: [
        { id: 10101, id_str: "10101", name: "Morning run", sport_type: "Run", distance: 5000 },
      ],
    });
    expect(upstream.calls.map((call) => call.url)).toEqual([
      "https://www.strava.com/api/v3/athlete/activities?after=1764547200&per_page=5",
    ]);
    // A string ID reaches Strava exactly; `id_str` keeps it in the result.
    expect(await (await alice.request("/rpc/activity")).json()).toMatchObject({
      status: "connected",
      data: { id_str: "18014398509481985", name: "Long run" },
    });
    expect(upstream.calls.at(-1)?.url).toBe(
      "https://www.strava.com/api/v3/activities/18014398509481985",
    );
    // Route exports arrive as text, as their XML media type says.
    // Routes are listed by the athlete's ID, which Strava's description leaves out.
    expect(await (await alice.request("/rpc/routes")).json()).toEqual({
      status: "connected",
      data: [{ id: 3001, id_str: "3001", name: "Loop" }],
    });
    expect(upstream.calls.at(-1)?.url).toBe(
      "https://www.strava.com/api/v3/athletes/101/routes?per_page=5",
    );
    expect(await (await alice.request("/rpc/gpx")).json()).toEqual({
      status: "connected",
      data: { contentType: "application/gpx+xml", text: '<?xml version="1.0"?><gpx/>' },
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
      .object({ accessToken: z.string(), refreshToken: z.string(), scope: z.string() })
      .parse(await db.prepare("SELECT accessToken, refreshToken, scope FROM account").first());

    // Encrypted through the app key binding, not with an app-held secret.
    expect(saved.accessToken).toMatch(/^v1\./);
    expect(JSON.stringify(saved)).not.toContain("synthetic-");
    // The scopes the callback named, which Strava's token answer leaves out.
    expect(saved.scope).toBe(
      "read,read_all,profile:read_all,profile:write,activity:read_all,activity:write",
    );
  });

  it("asks before changes as each user's approval level says and runs them only after approval", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.calls.length = 0;

    // By default, new activities, which followers see, and updates ask first.
    expect(await (await alice.request("/rpc/create")).json()).toEqual({
      resultType: "input_required",
      inputRequests: {
        approve: {
          message: `Run the Strava change "createActivity"? It sends something to other people.\n\nInput:\n${JSON.stringify(
            {
              body: {
                name: "Lunch run",
                sport_type: "Run",
                start_date_local: "2026-11-23T12:00:00Z",
                elapsed_time: 1800,
                distance: 5000,
                visibility: "only_me",
              },
            },
            null,
            2,
          )}`,
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });
    expect(await (await alice.request("/rpc/update")).json()).toMatchObject({
      resultType: "input_required",
    });
    expect(upstream.calls).toEqual([]);

    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/create")).json()).toEqual({ status: "declined" });
    expect(upstream.calls).toEqual([]);

    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      status: "connected",
      data: { id: 1001, name: "Lunch run" },
    });
    // Form fields go as a form, and updates as JSON.
    expect(upstream.calls[0]).toMatchObject({
      method: "POST",
      url: "https://www.strava.com/api/v3/activities",
      type: "application/x-www-form-urlencoded;charset=UTF-8",
      body: "name=Lunch+run&sport_type=Run&start_date_local=2026-11-23T12%3A00%3A00Z&elapsed_time=1800&distance=5000&visibility=only_me",
    });
    expect(await (await alice.request("/rpc/update")).json()).toMatchObject({
      status: "connected",
      data: { name: "Evening run" },
    });
    expect(upstream.calls[1]).toMatchObject({
      method: "PUT",
      url: "https://www.strava.com/api/v3/activities/1001",
      type: "application/json",
      body: JSON.stringify({ name: "Evening run", commute: true }),
    });
    // Uploads send the file in a multipart form.
    expect(await (await alice.request("/rpc/upload")).json()).toMatchObject({
      status: "connected",
      data: { id_str: "4001" },
    });
    expect(upstream.calls[2]).toMatchObject({
      method: "POST",
      url: "https://www.strava.com/api/v3/uploads",
      form: { file: "application/gpx+xml:<gpx/>", data_type: "gpx", name: "Morning ride" },
    });

    // Asking less asks the user to confirm; then nothing asks.
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
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      status: "connected",
    });

    // Tags are form fields keyed by the tag's name, as Strava's reference describes them.
    expect(await (await alice.request("/rpc/tagged")).json()).toMatchObject({
      status: "connected",
    });
    expect(upstream.calls.at(-1)?.body).toBe(
      "name=Walk&sport_type=Walk&start_date_local=2026-11-23T08%3A00%3A00Z&elapsed_time=900&tags%5BWithPet%5D=true",
    );

    // Each user has their own level.
    const bob = browser("bob");
    await connect(bob, "102");
    expect(await (await bob.request("/rpc/create")).json()).toMatchObject({
      resultType: "input_required",
    });
  });

  it("lets users choose their approval level on the app's page", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    const page = await (await alice.request("/")).text();
    expect(page).toContain("<strong>athlete101</strong>");
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

  it("asks athletes who granted fewer scopes to reconnect", async () => {
    const alice = browser("alice");
    await connect(alice, "101", "read,activity:read_all");

    for (const path of ["/rpc/list", "/rpc/status", "/rpc/create"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        status: "permission_required",
      });
    expect(upstream.calls).toEqual([]);
    await connect(alice, "101");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
  });

  // Widefleet's My connections page opens a single-use launch link, and the
  // connection returns to Widefleet through a single-use completion link.
  it("connects from Widefleet's launch link and returns there, also when cancelled", async () => {
    const alice = browser("alice");
    const completionUrl = "https://widefleet.example.test/connections?completed=strava";

    const prepare = async () =>
      z
        .object({ url: z.url(), expiresAt: z.iso.datetime() })
        .parse(
          await (
            await alice.request(
              "/rpc/personal/prepare",
              "POST",
              origin,
              JSON.stringify({ completionUrl }),
            )
          ).json(),
        );

    const open = async (url: string) => {
      const opened = await alice.request(url);
      const html = await opened.text();
      expect(opened.status, html).toBe(200);

      return z
        .string()
        .parse(/<a href="([^"]+)">/.exec(html)?.[1])
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
    };

    expect(await (await alice.request("/rpc/personal/status")).json()).toEqual({
      setup: "ready",
      connection: "disconnected",
      account: null,
    });
    const launch = await prepare();
    expect(Date.parse(launch.expiresAt)).toBeGreaterThan(Date.now());
    // Launch links belong to the user who prepared them and work once.
    expect((await browser("bob").request(launch.url)).status).toBe(410);
    const destination = await open(launch.url);
    expect((await alice.request(launch.url)).status).toBe(410);

    const returned = z
      .string()
      .parse((await alice.request(upstream.authorize(destination, "101"))).headers.get("location"));

    expect(new URL(returned).pathname).toBe("/connect/complete");
    expect((await browser("bob").request(returned)).status).toBe(410);
    const completed = await alice.request(returned);
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe(completionUrl);
    expect((await alice.request(returned)).status).toBe(410);
    expect(await (await alice.request("/rpc/personal/status")).json()).toMatchObject({
      connection: "connected",
      account: { id: "101" },
    });
    expect(await (await alice.request("/rpc/personal/disconnect", "POST")).json()).toEqual({
      disconnected: true,
    });

    // An expired launch link no longer opens.
    const expired = await prepare();
    const db = await runtime.getD1Database("DB");
    await db
      .prepare("UPDATE verification SET expiresAt = ? WHERE identifier LIKE 'widefleet:launch:%'")
      .bind(new Date(Date.now() - 1).toISOString())
      .run();
    expect((await alice.request(expired.url)).status).toBe(410);

    // A cancelled authorization returns to Widefleet with the error.
    const cancelled = new URL(await open((await prepare()).url));
    const denied = new URL(z.string().parse(cancelled.searchParams.get("redirect_uri")));
    denied.searchParams.set("state", z.string().parse(cancelled.searchParams.get("state")));
    denied.searchParams.set("error", "access_denied");
    const relay = z.string().parse((await alice.request(denied.href)).headers.get("location"));
    expect(new URL(relay).pathname).toBe("/connect/complete");
    expect((await alice.request(relay)).headers.get("location")).toBe(
      `${completionUrl}&connectionError=1`,
    );
    expect(await (await alice.request("/rpc/personal/status")).json()).toMatchObject({
      connection: "disconnected",
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

    // Switching athletes needs a disconnect first.
    const other = upstream.authorize(await start(alice), "999");
    expect((await alice.request(other)).headers.get("location")).toContain("error=");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({ accountId: "101" });

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

  it("refreshes rotating tokens, preserves accounts on outages and disconnects only the current user", async () => {
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

    // Each refresh uses the refresh token the previous one returned.
    for (const refreshes of [1, 2]) {
      await expire();
      expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
        status: "connected",
      });
      expect(upstream.state.refreshes).toBe(refreshes);
    }

    // The scopes survive refreshes, whose answers name none.
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
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

  it("reports Strava's errors, rate limits and revoked tokens", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.state.answer = {
      status: 404,
      body: {
        message: "Resource Not Found",
        errors: [{ resource: "Activity", field: "id", code: "not found" }],
      },
      headers: {},
    };
    expect(await (await alice.request("/rpc/activity")).json()).toEqual({
      status: "strava_error",
      error: {
        message: "Resource Not Found",
        errors: [{ resource: "Activity", field: "id", code: "not found" }],
        status: 404,
      },
    });
    upstream.state.answer = {
      status: 429,
      body: { message: "Rate Limit Exceeded", errors: [] },
      headers: { "x-ratelimit-limit": "200,2000", "x-ratelimit-usage": "200,350" },
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: null,
    });
    // Larger responses are not read.
    upstream.state.answer = {
      status: 200,
      body: [{ name: "x".repeat(9 * 1024 * 1024) }],
      headers: {},
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "too_large",
      maximumBytes: 8 * 1024 * 1024,
    });
    upstream.state.answer = { status: 502, body: null, headers: {} };
    expect((await alice.request("/rpc/list")).status).toBe(500);
    // Requests that do not match the operation never reach Strava.
    upstream.calls.length = 0;
    expect((await alice.request("/rpc/invalid")).status).toBe(500);
    expect(upstream.calls).toEqual([]);
    upstream.state.answer = {
      status: 401,
      body: { message: "Authorization Error", errors: [] },
      headers: {},
    };
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "reconnect_required",
    });
  });
});
