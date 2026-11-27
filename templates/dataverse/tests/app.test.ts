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

    // A cast is a segment of its own; without one the segment is left out.
    for (const query of [
      "",
      "?type=Microsoft.Dynamics.CRM.PicklistAttributeMetadata&expand=OptionSet",
    ])
      expect(await (await alice.request(`/rpc/column${query}`)).json()).toEqual({
        status: "connected",
        data: { LogicalName: "industrycode" },
      });
    expect(await (await alice.request("/rpc/function")).json()).toEqual({
      status: "connected",
      data: { Summary: "Short" },
    });
    expect(upstream.calls.slice(-3).map((call) => decodeURIComponent(call.url))).toEqual([
      `${sales}/EntityDefinitions(LogicalName='account')/Attributes(LogicalName='industrycode')`,
      `${sales}/EntityDefinitions(LogicalName='account')/Attributes(LogicalName='industrycode')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet`,
      // Parameter aliases are sent as the OData literals the caller wrote.
      `${sales}/msdyn_GetSummary(RecordId=@id)?@id='it''s'`,
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

    // OData addresses a table and an unbound action alike, so createRow asks
    // like an action, as deleting does, and nothing reaches Dataverse first.
    for (const path of ["/rpc/create", "/rpc/create?set=BulkDelete", "/rpc/delete"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        resultType: "input_required",
      });
    expect(upstream.calls).toHaveLength(0);

    // A column is created through its table's navigation property at once; a
    // bound action at that address is not.
    expect(await (await alice.request("/rpc/related")).json()).toEqual({
      status: "connected",
      data: null,
    });
    expect(upstream.calls.map(({ method, url }) => `${method} ${decodeURIComponent(url)}`)).toEqual(
      [`POST ${sales}/EntityDefinitions(LogicalName='new_scrap')/Attributes`],
    );

    for (const query of [
      "navigation=Microsoft.Dynamics.CRM.AddPrivilegesRole",
      `id=${encodeURIComponent("x)/Microsoft.Dynamics.CRM.BulkDelete(")}`,
    ])
      expect((await alice.request(`/rpc/related?${query}`)).status).toBe(500);
    expect(upstream.calls.filter(({ method }) => method === "POST")).toHaveLength(1);
    upstream.calls.length = 0;

    // Approved, the new row is created.
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      status: "connected",
      data: { accountid: "account-new" },
    });
    expect(upstream.calls).toMatchObject([
      { method: "POST", url: `${sales}/accounts`, body: JSON.stringify({ name: "New" }) },
    ]);
    upstream.calls.length = 0;

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

  it("runs batches as one change, uploads files and returns Dataverse's answer headers", async () => {
    const alice = browser("alice");
    await ready(alice, "101");

    const batch = (input: { environment: string; requests: unknown[] }) =>
      alice.request(`/rpc/batch?input=${encodeURIComponent(JSON.stringify(input))}`);

    const created = {
      environment: "sales.api.crm4.dynamics.com",
      requests: [
        {
          changeSet: [
            { method: "POST", url: "accounts", body: { name: "A" }, contentId: "1" },
            { method: "POST", url: "$1/contact_customer_accounts", body: { lastname: "B" } },
          ],
        },
        { method: "GET", url: "accounts?$select=name" },
      ],
    };

    // A new row at the root may be an action, so the batch asks; approved, the
    // answers come in order.
    expect(await (await batch(created)).json()).toMatchObject({ resultType: "input_required" });
    alice.identity.answer = "accept";
    expect(await (await batch(created)).json()).toEqual({
      status: "connected",
      data: {
        responses: [
          {
            contentId: "1",
            status: 204,
            headers: { "OData-EntityId": `${sales}/accounts(a-1)` },
            body: null,
          },
          // UTF-8 text decodes as text, and file bytes stay bytes.
          {
            status: 200,
            headers: { "Content-Type": "application/json; odata.metadata=minimal" },
            body: { value: [{ name: "Müller" }] },
          },
          {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
            body: { contentType: "application/octet-stream", base64: "AAH6/w==" },
          },
        ],
      },
    });
    const sent = upstream.calls.at(-1);

    expect(sent).toMatchObject({ method: "POST", url: `${sales}/$batch` });
    expect(sent?.type).toMatch(/^multipart\/mixed; boundary=batch_/);

    for (const line of [
      `POST ${sales}/accounts HTTP/1.1`,
      "Content-ID: 1",
      // Dataverse needs a Content-ID on every request of a change set.
      "Content-ID: 2",
      "POST $1/contact_customer_accounts HTTP/1.1",
      `GET ${sales}/accounts?$select=name HTTP/1.1`,
    ])
      expect(sent?.body).toContain(line);

    alice.identity.answer = "";

    // Binding existing rows to a new one changes them, and some functions write,
    // whichever method sends them.
    for (const path of ["/rpc/create-binding", "/rpc/increment"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        resultType: "input_required",
      });

    // A batch asks once for its strongest change: an action or a deletion asks.
    upstream.calls.length = 0;

    for (const request of [
      { method: "DELETE", url: "accounts(00000000-0000-0000-0000-000000000001)" },
      { method: "POST", url: "WinOpportunity", body: { Status: 3 } },
      { method: "POST", url: "accounts(a-1)/Microsoft.Dynamics.CRM.new_Approve" },
      { method: "POST", url: "accounts%2FMicrosoft.Dynamics.CRM.new_Approve" },
      {
        method: "POST",
        url: "accounts",
        body: { name: "A", "Account_Tasks@odata.bind": ["/tasks(1)"] },
      },
      { method: "PATCH", url: "accounts(1)", body: { name: "B" } },
    ])
      expect(
        await (await batch({ ...created, requests: [{ changeSet: [request] }] })).json(),
      ).toMatchObject({ resultType: "input_required" });
    expect(
      await (
        await batch({
          ...created,
          requests: [
            {
              method: "GET",
              url: "IncrementKnowledgeArticleViewCount(Source=@s,ViewDate=2026-11-26,Location=1,Count=1)",
            },
          ],
        })
      ).json(),
    ).toMatchObject({ resultType: "input_required" });

    // An action on a row a change set created keeps its own change.
    const sending = await (
      await batch({
        ...created,
        requests: [
          {
            changeSet: [
              { method: "POST", url: "emails", body: { subject: "Hi" }, contentId: "1" },
              {
                method: "POST",
                url: "$1/Microsoft.Dynamics.CRM.SendEmail",
                body: { IssueSend: true },
              },
            ],
          },
        ],
      })
    ).text();

    expect(sending).toContain("sends something to other people");
    expect(upstream.calls.filter(({ url }) => url.endsWith("$batch"))).toHaveLength(0);

    // A known action that only reads asks nothing.
    expect(
      await (
        await batch({
          ...created,
          requests: [{ method: "POST", url: "searchquery", body: { search: "x" } }],
        })
      ).json(),
    ).toMatchObject({ status: "connected" });

    // No request can add lines, leave the service or refer to a row no request creates.
    for (const request of [
      { method: "GET", url: "accounts", headers: { Prefer: "x\r\nDELETE accounts(1)" } },
      { method: "GET", url: "accounts", headers: { Authorization: "Bearer other" } },
      { method: "GET", url: "https://evil.example.test/" },
      { method: "GET", url: "../../other" },
      { method: "POST", url: "$9/contact_customer_accounts" },
    ])
      expect((await batch({ ...created, requests: [request] })).status).toBe(500);

    // A created row's address and a file upload's bytes.
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/create")).json()).toMatchObject({
      headers: { "OData-EntityId": `${sales}/accounts(account-new)` },
    });
    alice.identity.answer = "";

    // An upload replaces the file, so it asks first.
    expect(await (await alice.request("/rpc/upload")).json()).toMatchObject({
      resultType: "input_required",
    });
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/upload")).json()).toEqual({
      status: "connected",
      data: null,
    });
    expect(upstream.calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: `${sales}/accounts(00000000-0000-0000-0000-000000000001)/new_report?x-ms-file-name=Pr%C3%BCfbericht.pdf`,
      body: "%PDF-",
      type: "application/pdf",
    });
    expect(await (await alice.request("/rpc/unchanged")).json()).toEqual({
      status: "not_modified",
    });
    expect(await (await alice.request("/rpc/search")).json()).toMatchObject({
      status: "connected",
    });
    expect(upstream.calls.at(-1)).toMatchObject({
      method: "POST",
      url: `${environments.sales}/api/search/v2.0/query`,
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
    const db = await runtime.getD1Database("DB");
    const before = upstream.state.refreshes;
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "reconnect_required",
    });
    // The rejected token is not offered again.
    expect(await db.prepare("SELECT COUNT(*) AS count FROM resource_token").first("count")).toBe(0);
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({ status: "connected" });
    expect(upstream.state.refreshes).toBe(before + 1);
  });

  it("keeps the account's controls when discovery fails and never restores an old grant", async () => {
    const alice = browser("alice");
    await ready(alice, "101");
    const db = await runtime.getD1Database("DB");

    upstream.state.answer = { status: 503, body: null, headers: {} };
    const page = await (await alice.request("/")).text();
    expect(page).toContain("Your environments could not be listed");
    expect(page).toContain('action="/disconnect"');

    // A refresh answered after the account was disconnected and connected
    // again is not saved over the new grant.
    await db.prepare("DELETE FROM resource_token").run();
    upstream.state.duringRefresh = async () => {
      await db.prepare("UPDATE account SET refreshToken = 'v1.new-grant'").run();
    };

    expect(await (await alice.request("/rpc/who")).json()).toMatchObject({ status: "connected" });
    upstream.state.duringRefresh = null;
    expect(await db.prepare("SELECT COUNT(*) AS count FROM resource_token").first("count")).toBe(0);
    expect(await db.prepare("SELECT refreshToken FROM account").first("refreshToken")).toBe(
      "v1.new-grant",
    );
  });
});
