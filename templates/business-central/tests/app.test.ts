import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { api, pdf, provider } from "./provider.ts";

describe("Business Central personal account app", () => {
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

  const companies = `${api}/v2.0/production/api/v2.0/companies`;

  const customers = `${companies}(8b4f0a20-0000-4000-8000-000000000001)/customers`;

  const scopes = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "https://api.businesscentral.dynamics.com/Financials.ReadWrite.All",
  ].join(" ");

  it("shows missing settings before setup without attempting OAuth", async () => {
    await runtime.setOptions(configuration(false));
    const alice = browser("alice");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "setup_required",
      missing: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain("/auth/callback/microsoft");
    expect(page).toContain("Financials.ReadWrite.All");
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });

  it("asks Microsoft for Business Central's scope alone, so tokens are for Business Central", async () => {
    const alice = browser("alice");
    const destination = new URL(await start(alice));
    // Graph's User.Read would make Microsoft issue a token for Graph instead.
    expect(destination.searchParams.get("scope")).toBe(scopes);
    const response = await alice.request(upstream.authorize(destination.href, "101"));
    expect(response.headers.get("location"), await response.text()).toBe(`${origin}/`);
    const db = await runtime.getD1Database("DB");
    await db
      .prepare("UPDATE account SET accessTokenExpiresAt = ?")
      .bind(Date.now() - 60000)
      .run();
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({ status: "connected" });
    expect(upstream.state.refreshes).toBe(1);
    // The code's token is for the authorization's scopes; each refresh names them.
    expect(upstream.state.requested).toEqual([null, scopes]);
  });

  it("reads environments, companies and pages of filtered entities and isolates users", async () => {
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
    expect(await (await alice.request("/rpc/environments")).json()).toMatchObject({
      status: "connected",
      data: { value: [{ name: "production", type: "Production" }] },
    });
    expect(await (await alice.request("/rpc/list")).json()).toEqual({
      status: "connected",
      data: {
        value: [
          {
            id: "8b4f0a20-0000-4000-8000-000000000001",
            name: "CRONUS",
            displayName: "CRONUS",
          },
        ],
      },
    });

    const listed = z
      .object({
        status: z.literal("connected"),
        data: z.object({
          value: z.array(z.object({ "@odata.etag": z.string(), displayName: z.string() })),
          "@odata.nextLink": z.url(),
        }),
      })
      .parse(await (await alice.request("/rpc/customers")).json());

    expect(listed.data.value.map((entity) => entity.displayName)).toEqual(["Adatum"]);
    // OData's query options keep their names; lists are joined with commas.
    expect(upstream.calls.map((call) => call.url)).toEqual([
      `${api}/environments/v1.2`,
      companies,
      `${customers}?%24filter=balanceDue+gt+0&%24select=id%2Cnumber%2CdisplayName&%24top=50`,
    ]);

    // A later page is read at the address Business Central gave.
    const next = listed.data["@odata.nextLink"];

    expect(
      await (await alice.request(`/rpc/next?link=${encodeURIComponent(next)}`)).json(),
    ).toMatchObject({ status: "connected", data: { value: [{ displayName: "Trey Research" }] } });
    expect(upstream.calls.at(-1)?.url).toBe(next);
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

  it("changes entities at the version read, after approval, and reports conflicts", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.calls.length = 0;
    const etag = 'W/"JzE5OzEwMDAwMDAwMDAwMDAwMDAwMDA7MDA7Jw==1"';
    const update = `/rpc/update?etag=${encodeURIComponent(etag)}`;

    // Changing asks by default; creating does not.
    expect(await (await alice.request(update)).json()).toEqual({
      resultType: "input_required",
      inputRequests: {
        approve: {
          message: `Run the Business Central change "updateCustomer"? It changes existing data.\n\nInput:\n${JSON.stringify(
            {
              environment: "production",
              companyId: "8b4f0a20-0000-4000-8000-000000000001",
              customerId: "c-10000",
              etag,
              body: { displayName: "Adatum Corporation" },
            },
            null,
            2,
          )}`,
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });
    expect(upstream.calls).toEqual([]);
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      status: "connected",
      data: { id: "c-30000", displayName: "Fabrikam" },
    });

    alice.identity.answer = "decline";
    expect(await (await alice.request(update)).json()).toEqual({ status: "declined" });

    alice.identity.answer = "accept";
    expect(await (await alice.request(update)).json()).toMatchObject({
      status: "connected",
      data: { displayName: "Adatum Corporation" },
    });
    expect(upstream.calls).toEqual([
      {
        method: "POST",
        url: customers,
        body: JSON.stringify({ displayName: "Fabrikam" }),
        type: "application/json",
        match: null,
      },
      {
        method: "PATCH",
        url: `${customers}(c-10000)`,
        body: JSON.stringify({ displayName: "Adatum Corporation" }),
        type: "application/json",
        match: etag,
      },
    ]);

    // The customer changed since `etag` was read.
    expect(await (await alice.request(update)).json()).toEqual({
      status: "business_central_error",
      error: {
        code: "Request_EntityChanged",
        message: "Another user has already changed the record.",
        status: 412,
      },
    });
    expect(
      await (
        await alice.request(`/rpc/delete?etag=${encodeURIComponent(etag.replace(/1"$/, '2"'))}`)
      ).json(),
    ).toEqual({ status: "connected", data: null });

    // A change without its version never reaches Business Central.
    upstream.calls.length = 0;
    expect((await alice.request("/rpc/update-without-etag")).status).toBe(500);
    expect(upstream.calls).toEqual([]);
  });

  it("asks before posting and sending documents and downloads their PDFs", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.calls.length = 0;

    const question = async (path: string) =>
      z
        .object({
          resultType: z.literal("input_required"),
          inputRequests: z.object({ approve: z.object({ message: z.string() }) }),
        })
        .parse(await (await alice.request(path)).json()).inputRequests.approve.message;

    // Posting changes the invoice for good; sending emails it to the customer.
    expect(await question("/rpc/post")).toContain('"postSalesInvoice"? It changes existing data.');
    expect(await question("/rpc/send")).toContain(
      '"sendSalesInvoice"? It sends something to other people.',
    );
    expect(upstream.calls).toEqual([]);

    alice.identity.answer = "accept";

    for (const path of ["/rpc/post", "/rpc/send"])
      expect(await (await alice.request(path)).json()).toEqual({ status: "connected", data: null });
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${companies}(8b4f0a20-0000-4000-8000-000000000001)/salesInvoices(i-1)/Microsoft.NAV.post`,
      `POST ${companies}(8b4f0a20-0000-4000-8000-000000000001)/salesInvoices(i-1)/Microsoft.NAV.send`,
    ]);

    // Reading a PDF never asks; its bytes arrive as base64.
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/pdf")).json()).toEqual({
      status: "connected",
      data: { contentType: "application/pdf", base64: btoa(String.fromCharCode(...pdf)) },
    });

    // Asking less asks the user to confirm; then documents are sent at once.
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toMatchObject({
      resultType: "input_required",
    });
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toEqual({
      status: "updated",
      level: "none",
    });
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/send")).json()).toMatchObject({ status: "connected" });

    // Each user has their own level.
    const bob = browser("bob");
    await connect(bob, "102");
    expect(await (await bob.request("/rpc/send")).json()).toMatchObject({
      resultType: "input_required",
    });
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
    expect(await (await browser("alice").request("/rpc/send")).json()).toMatchObject({
      status: "connection_required",
    });
    expect(await (await runtime.dispatchFetch(`${origin}/rpc/level`)).json()).toEqual({
      status: "authentication_required",
    });
  });

  it("asks users whose consent lacks Business Central's scope to reconnect", async () => {
    // A consent for Graph alone, as an earlier Microsoft template asked for.
    upstream.state.scope = "openid profile email offline_access User.Read";
    const alice = browser("alice");
    await connect(alice, "101");

    for (const path of ["/rpc/list", "/rpc/status", "/rpc/send"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        status: "permission_required",
      });
    expect(upstream.calls).toEqual([]);
    upstream.state.scope = scopes;
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

  it("reports Business Central's errors, throttling and revoked tokens", async () => {
    const alice = browser("alice");
    await connect(alice, "101");
    upstream.state.answer = {
      status: 404,
      body: {
        error: {
          code: "BadRequest_NotFound",
          message: "The specified resource could not be found.",
        },
      },
      headers: {},
    };
    expect(await (await alice.request("/rpc/customers")).json()).toEqual({
      status: "business_central_error",
      error: {
        code: "BadRequest_NotFound",
        message: "The specified resource could not be found.",
        status: 404,
      },
    });
    upstream.state.answer = {
      status: 429,
      body: { error: { code: "Application_TooManyRequests", message: "Too many requests" } },
      headers: { "retry-after": "20" },
    };
    expect(await (await alice.request("/rpc/customers")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "20",
    });
    // Larger responses are not read.
    upstream.state.answer = {
      status: 200,
      body: { value: [{ displayName: "x".repeat(9 * 1024 * 1024) }] },
      headers: {},
    };
    expect(await (await alice.request("/rpc/customers")).json()).toEqual({
      status: "too_large",
      maximumBytes: 8 * 1024 * 1024,
    });
    // Business Central ends requests that run longer than ten minutes.
    upstream.state.answer = { status: 504, body: null, headers: {} };
    expect((await alice.request("/rpc/customers")).status).toBe(500);
    // Requests that do not match the operation never reach Business Central.
    upstream.calls.length = 0;
    expect((await alice.request("/rpc/invalid")).status).toBe(500);
    expect(
      (await alice.request(`/rpc/next?link=${encodeURIComponent("https://other.example.test/")}`))
        .status,
    ).toBe(500);
    // A link to another entity set is not a later page of this method.
    expect(
      (
        await alice.request(
          `/rpc/next?link=${encodeURIComponent(`${companies}(8b4f0a20-0000-4000-8000-000000000001)/vendors?$skiptoken=2`)}`,
        )
      ).status,
    ).toBe(500);
    expect(upstream.calls).toEqual([]);
    upstream.state.answer = { status: 401, body: null, headers: {} };
    expect(await (await alice.request("/rpc/customers")).json()).toMatchObject({
      status: "reconnect_required",
    });
  });
});
