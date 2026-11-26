import { build } from "esbuild";
import { Headers, Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { activityFile, provider } from "./provider.ts";

describe("Garmin Connect personal API app", () => {
  const origin = "https://garmin.example.test:25453";
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

  const configuration = () =>
    ({
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: "garmin-test",
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: script } },
            },
            env: {
              DB: { type: "d1", id: "accounts" },
              WIDEFLEET_ORIGIN: { type: "json", value: origin },
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
    const identity = { subject, issuer: "https://identity.example.test" };

    const send = (path: string, method: string, body: string | null, type: string | null) => {
      const headers = new Headers({
        origin,
        "test-subject": identity.subject,
        "test-issuer": identity.issuer,
      });

      if (type) headers.set("content-type", type);

      return runtime.dispatchFetch(new URL(path, origin).href, {
        method,
        redirect: "manual",
        headers,
        body,
      });
    };

    return {
      identity,
      request: (path: string, method = "GET") => send(path, method, null, null),
      json: async (path: string) => (await send(path, "GET", null, null)).json(),
      post: (path: string, form: Record<string, string>) =>
        send(
          path,
          "POST",
          new URLSearchParams(form).toString(),
          "application/x-www-form-urlencoded",
        ),
      prepare: async (completionUrl: string) =>
        z
          .object({ url: z.url(), expiresAt: z.iso.datetime() })
          .parse(
            await (
              await send(
                "/rpc/personal/prepare",
                "POST",
                JSON.stringify({ completionUrl }),
                "application/json",
              )
            ).json(),
          ),
    };
  };

  const connect = async (client: ReturnType<typeof browser>, key: string) => {
    const response = await client.post("/connect", { key });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  };

  const database = () => runtime.getD1Database("DB");

  // Moves every saved access token's expiry, as if time had passed.
  const expireTokens = async (expiresAt = Date.now() - 1000) => {
    await (
      await database()
    )
      .prepare("UPDATE api_key SET accessTokenExpiresAt = ?")
      .bind(expiresAt)
      .run();
  };

  it("connects with the user's own Personal API key and reads typed data with one token", async () => {
    const alice = browser("alice");
    expect(await alice.json("/rpc/activities")).toEqual({
      status: "connection_required",
      connectUrl: origin,
    });
    expect(await alice.json("/rpc/personal/status")).toEqual({
      setup: "ready",
      connection: "disconnected",
      account: null,
    });
    const empty = await (await alice.request("/")).text();
    expect(empty).toContain('name="key" type="password"');
    expect(empty).toContain("https://connect.garmin.com/app/settings/personalApiToken");

    const key = upstream.createKey("alice");
    await connect(alice, key);
    expect(await alice.json("/rpc/status")).toEqual({
      status: "connected",
      account: "alice-runner",
      connectUrl: origin,
    });
    expect(await alice.json("/rpc/personal/status")).toEqual({
      setup: "ready",
      connection: "connected",
      account: { id: "alice-runner", label: "alice-runner" },
    });
    expect(await alice.json("/rpc/activities")).toEqual({
      status: "connected",
      data: [{ activityId: 1001, activityName: "alice's morning run", distance: 5012.4 }],
    });
    expect(await alice.json("/rpc/sleep")).toEqual({
      status: "connected",
      data: { calendarDate: "2026-11-20", sleepTimeSeconds: 27000 },
    });
    // A day without HRV data answers 204.
    expect(await alice.json("/rpc/hrv")).toEqual({ status: "connected", data: null });
    // The original activity file arrives as JSON, as MCP needs: base64 of the ZIP archive.
    expect(await alice.json("/rpc/download")).toEqual({
      status: "connected",
      data: {
        contentType: "application/x-zip-compressed",
        base64: btoa(String.fromCharCode(...activityFile)),
      },
    });
    expect(upstream.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://personal.connectapi.garmin.com/userprofile-service/userprofile/settings",
      "GET https://personal.connectapi.garmin.com/activitylist-service/activities/search/activities?limit=5&activityType=running",
      "GET https://personal.connectapi.garmin.com/sleep-service/sleep/dailySleep?date=2026-11-20",
      "GET https://personal.connectapi.garmin.com/hrv-service/hrv/2026-11-20",
      "GET https://personal.connectapi.garmin.com/download-service/files/activity/1001",
    ]);
    // Connecting issued the only token; every read reused it.
    expect(upstream.state.issued).toBe(1);

    // Each user and identity issuer has their own connection.
    expect(await browser("bob").json("/rpc/status")).toMatchObject({
      status: "connection_required",
    });
    alice.identity.issuer = "https://other-identity.example.test";
    expect(await alice.json("/rpc/status")).toMatchObject({ status: "connection_required" });
    alice.identity.issuer = "https://identity.example.test";

    // The key and token are encrypted through the app key binding and never shown again.
    const saved = z
      .object({ apiKey: z.string(), accessToken: z.string() })
      .parse(await (await database()).prepare("SELECT apiKey, accessToken FROM api_key").first());

    expect(saved.apiKey).toMatch(/^v1\./);
    expect(saved.accessToken).toMatch(/^v1\./);
    expect(JSON.stringify(saved)).not.toContain("synthetic-");
    const page = await (await alice.request("/")).text();
    expect(page).toContain("<strong>alice-runner</strong>");
    expect(page).not.toContain(key);
  });

  it("issues a new token when the saved one expires and once when Garmin refuses it", async () => {
    const alice = browser("alice");
    await connect(alice, upstream.createKey("alice"));

    await expireTokens();
    expect(await alice.json("/rpc/activities")).toMatchObject({ status: "connected" });
    expect(upstream.state.issued).toBe(2);
    // A token that expires within a minute is replaced before it is used.
    await expireTokens(Date.now() + 30_000);
    expect(await alice.json("/rpc/activities")).toMatchObject({ status: "connected" });
    expect(upstream.state.issued).toBe(3);
    expect(await alice.json("/rpc/activities")).toMatchObject({ status: "connected" });
    expect(upstream.state.issued).toBe(3);

    // Garmin refuses a token before its expiry: the key issues a new one, once.
    upstream.expireTokens();
    expect(await alice.json("/rpc/activities")).toMatchObject({ status: "connected" });
    expect(upstream.state.issued).toBe(4);

    // A freshly issued token that Garmin refuses is not replaced again.
    await expireTokens();
    upstream.state.answer = { status: 401, body: null, headers: {} };
    expect(await alice.json("/rpc/activities")).toEqual({
      status: "reconnect_required",
      connectUrl: origin,
    });
    expect(upstream.state.issued).toBe(5);

    // An outage of the token endpoint keeps the key.
    await expireTokens();
    upstream.state.tokenStatus = 503;
    expect(await alice.json("/rpc/activities")).toEqual({ status: "token_failed" });
    upstream.state.tokenStatus = 429;
    expect(await alice.json("/rpc/activities")).toEqual({
      status: "rate_limited",
      retryAfter: null,
    });
    expect(await alice.json("/rpc/status")).toMatchObject({ status: "connected" });
    upstream.state.tokenStatus = null;
    expect(await alice.json("/rpc/activities")).toMatchObject({ status: "connected" });
  });

  it("shares one new token between overlapping reads", async () => {
    const alice = browser("alice");
    await connect(alice, upstream.createKey("alice"));
    upstream.state.tokenDelay = 200;

    const overlapping = () =>
      Promise.all(Array.from({ length: 5 }, async () => alice.json("/rpc/activities")));

    // The saved token expired: one request issues a new one, the others wait for it.
    await expireTokens();

    for (const result of await overlapping()) expect(result).toMatchObject({ status: "connected" });

    expect(upstream.state.issued).toBe(2);

    // Garmin refuses the saved token: again one request replaces it for all.
    upstream.expireTokens();

    for (const result of await overlapping()) expect(result).toMatchObject({ status: "connected" });

    expect(upstream.state.issued).toBe(3);
  });

  it("asks for a new key once Garmin no longer accepts the saved one", async () => {
    const alice = browser("alice");
    const key = upstream.createKey("alice");
    await connect(alice, key);
    upstream.deleteKey(key);

    // The saved token stopped working with its key; the key issues no new one.
    expect(await alice.json("/rpc/activities")).toEqual({
      status: "reconnect_required",
      connectUrl: origin,
    });
    expect(await alice.json("/rpc/status")).toEqual({
      status: "reconnect_required",
      connectUrl: origin,
    });
    expect(await alice.json("/rpc/personal/status")).toMatchObject({
      connection: "disconnected",
      account: null,
    });
    expect(await (await alice.request("/")).text()).toContain("Garmin no longer accepts the key");
    const issued = upstream.state.issued;
    expect(await alice.json("/rpc/activities")).toMatchObject({ status: "reconnect_required" });
    expect(upstream.state.issued).toBe(issued);

    await connect(alice, upstream.createKey("alice"));
    expect(await alice.json("/rpc/activities")).toMatchObject({ status: "connected" });
  });

  it("refuses keys Garmin does not accept, foreign forms and anonymous callers", async () => {
    const alice = browser("alice");
    const refused = await alice.post("/connect", { key: "synthetic-unknown-key" });
    expect(refused.headers.get("location")).toBe("/?error=rejected");
    expect((await alice.post("/connect", { key: " " })).headers.get("location")).toBe(
      "/?error=rejected",
    );
    expect(await (await alice.request("/?error=rejected")).text()).toContain(
      "Garmin did not accept this key",
    );

    upstream.state.tokenStatus = 503;
    expect(
      (await alice.post("/connect", { key: upstream.createKey("alice") })).headers.get("location"),
    ).toBe("/?error=unavailable");
    upstream.state.tokenStatus = null;

    const foreign = await runtime.dispatchFetch(`${origin}/connect`, {
      method: "POST",
      body: new URLSearchParams({ key: upstream.createKey("alice") }).toString(),
      headers: {
        origin: "https://other.example.test",
        "content-type": "application/x-www-form-urlencoded",
        "test-subject": "alice",
      },
    });

    expect(foreign.status).toBe(403);
    expect(
      await (await database()).prepare("SELECT COUNT(*) AS count FROM api_key").first("count"),
    ).toBe(0);
    expect(await alice.json("/rpc/status")).toMatchObject({ status: "connection_required" });

    expect((await runtime.dispatchFetch(origin)).status).toBe(401);
    expect(await (await runtime.dispatchFetch(`${origin}/rpc/activities`)).json()).toEqual({
      status: "authentication_required",
    });
    expect((await alice.request("/auth/callback/garmin")).status).toBe(404);
  });

  it("connects from Widefleet's connections page and returns there", async () => {
    const alice = browser("alice");
    const completionUrl = "https://widefleet.example.test/connections?app=garmin";
    const launch = await alice.prepare(completionUrl);
    expect(launch.url).toMatch(new RegExp(`^${origin}/connect/start\\?ticket=`));

    // Another user cannot use the link.
    expect((await browser("bob").request(launch.url)).status).toBe(410);

    const started = await alice.request(launch.url);
    expect(started.status).toBe(303);
    const asking = z.string().parse(started.headers.get("location"));
    const ticket = z.string().parse(new URL(asking, origin).searchParams.get("ticket"));
    expect(await (await alice.request(asking)).text()).toContain(
      `<input type="hidden" name="ticket" value="${ticket}">`,
    );
    expect((await alice.request(launch.url)).status).toBe(410);

    // A refused key asks again, still on the way back.
    const refused = await alice.post("/connect", { key: "synthetic-unknown-key", ticket });
    expect(refused.headers.get("location")).toBe(`/?error=rejected&ticket=${ticket}`);

    // A Garmin outage while checking the key asks again too.
    upstream.state.offline = true;
    const unreachable = await alice.post("/connect", { key: upstream.createKey("alice"), ticket });
    expect(unreachable.headers.get("location")).toBe(`/?error=unavailable&ticket=${ticket}`);
    upstream.state.offline = false;

    // The form ends on the app's own page, as its form-action policy requires,
    // which then navigates back to Widefleet.
    const saved = await alice.post("/connect", { key: upstream.createKey("alice"), ticket });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("location")).toBeNull();
    const back = `/connect/complete?ticket=${ticket}`;
    expect(await saved.text()).toContain(
      `<meta http-equiv="refresh" content="0;url=${back}"><p>Your Garmin account is connected. <a href="${back}">`,
    );
    const completed = await alice.request(`/connect/complete?ticket=${ticket}`);
    expect(completed.headers.get("location")).toBe(completionUrl);
    expect((await alice.request(`/connect/complete?ticket=${ticket}`)).status).toBe(410);
    expect(await alice.json("/rpc/personal/status")).toMatchObject({ connection: "connected" });
  });

  it("disconnects only the current user", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    await connect(alice, upstream.createKey("alice"));
    await connect(bob, upstream.createKey("bob"));

    expect(await alice.json("/rpc/personal/disconnect")).toEqual({ disconnected: true });
    expect(await alice.json("/rpc/activities")).toMatchObject({ status: "connection_required" });
    expect(await bob.json("/rpc/activities")).toMatchObject({ status: "connected" });

    expect((await bob.request("/disconnect", "POST")).headers.get("location")).toBe("/");
    expect(await bob.json("/rpc/status")).toMatchObject({ status: "connection_required" });
    expect(
      await (await database()).prepare("SELECT COUNT(*) AS count FROM api_key").first("count"),
    ).toBe(0);
  });

  it("reports Garmin's errors, throttling and large results", async () => {
    const alice = browser("alice");
    await connect(alice, upstream.createKey("alice"));
    upstream.state.answer = {
      status: 400,
      body: { message: "The date range must not exceed 28 days" },
      headers: {},
    };
    expect(await alice.json("/rpc/steps")).toEqual({
      status: "garmin_error",
      error: { status: 400, body: { message: "The date range must not exceed 28 days" } },
    });
    upstream.state.answer = { status: 500, body: null, headers: {} };
    expect(await alice.json("/rpc/steps")).toEqual({
      status: "garmin_error",
      error: { status: 500, body: null },
    });
    upstream.state.answer = { status: 429, body: null, headers: { "retry-after": "30" } };
    expect(await alice.json("/rpc/steps")).toEqual({ status: "rate_limited", retryAfter: "30" });
    // Larger responses are not read.
    upstream.state.answer = {
      status: 200,
      body: [{ calendarDate: "x".repeat(9 * 1024 * 1024) }],
      headers: {},
    };
    expect(await alice.json("/rpc/steps")).toEqual({
      status: "too_large",
      maximumBytes: 8 * 1024 * 1024,
    });
    // Requests that do not match the operation never reach Garmin.
    upstream.calls.length = 0;
    expect((await alice.request("/rpc/invalid")).status).toBe(500);
    expect(upstream.calls).toEqual([]);
  });
});
