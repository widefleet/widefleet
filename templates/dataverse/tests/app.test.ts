import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { environments, provider } from "./provider.ts";

describe("Dataverse personal account app", () => {
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

    return destination.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
  };

  const connect = async (client: ReturnType<typeof browser>, user: string) => {
    const response = await client.request(upstream.authorize(await start(client), user));
    expect(response.headers.get("location"), await response.text()).toBe(`${origin}/`);
  };

  const sales = `${environments.sales}/api/data/v9.2`;

  const ready = async (client: ReturnType<typeof browser>, user: string) => {
    await connect(client, user);
    upstream.calls.length = 0;
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

  it("lists the environments discovery lists for each user", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
      accountId: "101",
    });
    // Disabled environments are left out.
    expect(await (await alice.request("/rpc/environments")).json()).toEqual({
      status: "connected",
      environments: [
        { name: "Sales", environment: "sales.api.crm4.dynamics.com", administrator: true },
        { name: "Test", environment: "test.api.crm4.dynamics.com", administrator: false },
      ],
    });
    expect(await (await alice.request("/")).text()).toContain(
      `widefleet network allow ${environments.sales}`,
    );
    expect(await (await browser("bob").request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
  });

  it("sends typed requests to the environment each call names, with a token for it", async () => {
    const alice = browser("alice");
    await ready(alice, "101");
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "connected",
      data: {
        value: [{ accountid: "account-101", name: "Contoso" }],
        "@odata.nextLink": `${sales}/accounts?$skiptoken=page-2`,
      },
    });
    // OData lists are joined with commas.
    expect(upstream.calls.map((call) => call.url)).toEqual([
      `${sales}/accounts?%24select=name%2Caccountnumber&%24top=5`,
    ]);
    // One refresh for the environment's resource; later calls reuse its token.
    expect(upstream.state.refreshes).toBe(1);

    // Another environment gets its own token, which goes only to it.
    expect(
      await (await alice.request("/rpc/list?environment=test.api.crm4.dynamics.com")).json(),
    ).toMatchObject({ status: "connected" });
    expect(upstream.state.refreshes).toBe(2);
    expect(upstream.calls.at(-1)?.url).toContain(environments.test);
    // A host is all an environment can be.
    expect(
      (await alice.request(`/rpc/list?environment=${encodeURIComponent("evil.example.test/x?")}`))
        .status,
    ).toBe(500);
    const next = `${sales}/accounts?$skiptoken=page-2`;
    expect(
      await (await alice.request(`/rpc/next?link=${encodeURIComponent(next)}`)).json(),
    ).toMatchObject({ status: "connected", data: { value: [{ accountid: "account-2" }] } });
    expect(upstream.state.refreshes).toBe(2);

    // Functions are called with their parameters written into the call.
    expect(await (await alice.request("/rpc/who")).json()).toMatchObject({
      status: "connected",
      data: { UserId: "user-101" },
    });
    expect(await (await alice.request("/rpc/count")).json()).toMatchObject({
      status: "connected",
    });
    expect(upstream.calls.slice(-2).map((call) => decodeURIComponent(call.url))).toEqual([
      `${sales}/WhoAmI()`,
      `${sales}/RetrieveTotalRecordCount(EntityNames=@EntityNames)?@EntityNames=["account"]`,
    ]);
    expect(await (await alice.request("/rpc/metadata")).json()).toEqual({
      status: "connected",
      data: { contentType: "application/xml", text: "<edmx:Edmx/>" },
    });

    const db = await runtime.getD1Database("DB");

    const saved = z
      .object({ accessToken: z.string() })
      .parse(await db.prepare("SELECT accessToken FROM resource_token").first());

    // Encrypted through the app key binding, not with an app-held secret.
    expect(saved.accessToken).toMatch(/^v1\./);
  });

  it("asks before changes as each user's approval level says and runs them only after approval", async () => {
    const alice = browser("alice");
    await ready(alice, "101");

    // By default, creating runs at once; deleting asks first.
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      status: "connected",
      data: { accountid: "account-new" },
    });
    expect(upstream.calls[0]).toMatchObject({
      method: "POST",
      url: `${sales}/accounts`,
      body: JSON.stringify({ name: "New" }),
      type: "application/json",
    });
    expect(await (await alice.request("/rpc/delete")).json()).toMatchObject({
      resultType: "input_required",
    });
    expect(upstream.calls).toHaveLength(1);

    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/delete")).json()).toEqual({ status: "declined" });
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/delete")).json()).toEqual({
      status: "connected",
      data: null,
    });
    expect(upstream.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: `${sales}/accounts(00000000-0000-0000-0000-000000000001)`,
    });
  });

  it("asks users who did not consent to Dataverse to reconnect", async () => {
    upstream.state.scope = "openid profile email offline_access";
    const alice = browser("alice");
    await connect(alice, "101");

    for (const path of ["/rpc/list", "/rpc/status", "/rpc/environments"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        status: "permission_required",
      });
    expect(upstream.calls).toEqual([]);
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
  });

  it("refreshes environment tokens, keeps accounts on outages and disconnects only the current user", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    await ready(alice, "101");
    await ready(bob, "102");
    const db = await runtime.getD1Database("DB");
    await (await alice.request("/rpc/list")).json();
    await (await bob.request("/rpc/list")).json();
    const before = upstream.state.refreshes;

    await db.prepare("UPDATE resource_token SET expiresAt = ?").bind(Date.now()).run();
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({ status: "connected" });
    expect(upstream.state.refreshes).toBe(before + 1);

    await db.prepare("UPDATE resource_token SET expiresAt = ?").bind(Date.now()).run();
    upstream.state.unavailable = true;
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "refresh_failed",
    });
    upstream.state.unavailable = false;
    expect((await alice.request("/disconnect", "POST")).status).toBe(303);
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM resource_token").first("count")).toBe(1);
    expect(await (await bob.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
  });

  it("reports Dataverse's errors, throttling, blocked origins and revoked tokens", async () => {
    const alice = browser("alice");
    await ready(alice, "101");
    upstream.state.answer = {
      status: 404,
      body: { error: { code: "0x80040217", message: "account With Id = x Does Not Exist" } },
      headers: {},
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "dataverse_error",
      error: { code: "0x80040217", message: "account With Id = x Does Not Exist", status: 404 },
    });
    upstream.state.answer = {
      status: 429,
      body: { error: { code: "0x80072322", message: "Number of requests exceeded the limit" } },
      headers: { "retry-after": "20" },
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "20",
    });
    // Widefleet answers an origin the app may not reach with a plain 403.
    upstream.state.answer = { status: 403, body: null, headers: {} };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "network_required",
      origin: environments.sales,
    });
    upstream.state.answer = {
      status: 200,
      body: { value: [{ name: "x".repeat(9 * 1024 * 1024) }] },
      headers: {},
    };
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "too_large",
      maximumBytes: 8 * 1024 * 1024,
    });
    // Requests that do not match the operation never reach Dataverse.
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
