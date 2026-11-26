import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { allScopes, provider } from "./provider.ts";

describe("Qonto personal account app", () => {
  const origin = "https://qonto.example.test:25453";
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
              QONTO_CLIENT_ID: { type: "json", value: configured ? "test-qonto-client" : "" },
              QONTO_CLIENT_SECRET: { type: "json", value: configured ? "test-qonto-secret" : "" },
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

  const connect = async (client: ReturnType<typeof browser>, user: string) => {
    const response = await client.request(upstream.authorize(await start(client), user));
    expect(response.headers.get("location"), await response.text()).toBe(`${origin}/`);
  };

  it("shows the Qonto app to register before setup without attempting OAuth", async () => {
    await runtime.setOptions(configuration(false));
    const alice = browser("alice");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "setup_required",
      missing: ["QONTO_CLIENT_ID", "QONTO_CLIENT_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain(`${origin}/auth/callback/qonto`);
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });

  it("connects members with the organization's app and isolates users and identity issuers", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    expect(await (await alice.request("/rpc/transactions")).json()).toMatchObject({
      status: "connection_required",
    });
    await connect(alice, "10129");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
      accountId: "membership-10129",
    });
    expect(await (await alice.request("/rpc/personal/status")).json()).toEqual({
      setup: "ready",
      connection: "connected",
      account: { id: "membership-10129", label: "member10129@example.test" },
    });
    upstream.calls.length = 0;
    expect(await (await alice.request("/rpc/transactions")).json()).toMatchObject({
      status: "connected",
      data: { transactions: [{ label: "Coffee for 10129" }], meta: { next_page: null } },
    });
    // Reading sends no idempotency key.
    expect(upstream.calls).toEqual([
      {
        method: "GET",
        url: "https://thirdparty.qonto.com/v2/transactions?iban=FR7616798000010000004321396&per_page=1",
      },
    ]);
    upstream.calls.length = 0;
    // Each client filter is its own query parameter.
    expect(await (await alice.request("/rpc/clients")).json()).toMatchObject({
      status: "connected",
    });
    expect(upstream.calls.map((call) => call.url)).toEqual([
      "https://thirdparty.qonto.com/v2/clients?per_page=10&filter%5Bname%5D=Acme",
    ]);
    // Files arrive as content.
    expect(await (await alice.request("/rpc/certificate")).json()).toMatchObject({
      status: "connected",
      data: { contentType: "application/pdf" },
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

  // Widefleet asks first; Qonto then asks for approval on the paired phone for a
  // beneficiary the organization has not trusted. The call finishes once Qonto
  // reports the approval, repeating the first request's idempotency key.
  it("finishes a transfer after the user approves it in Qonto", async () => {
    const alice = browser("alice");
    await connect(alice, "10129");
    upstream.calls.length = 0;

    const asked = z
      .object({ inputRequests: z.object({ approve: z.object({ message: z.string() }) }) })
      .parse(await (await alice.request("/rpc/transfer")).json());

    expect(asked.inputRequests.approve.message).toContain(
      'Run the Qonto change "createSepaTransfer"? It sends something to other people.',
    );
    expect(upstream.calls).toEqual([]);

    alice.identity.answer = "accept";

    const question = z
      .object({
        resultType: z.literal("input_required"),
        inputRequests: z.object({ approveInQonto: z.object({ message: z.string() }) }),
        requestState: z.object({ scaSessionToken: z.string(), idempotencyKey: z.string() }),
      })
      .parse(await (await alice.request("/rpc/transfer")).json());

    expect(question.inputRequests.approveInQonto.message).toBe(
      'Qonto asks you to approve "createSepaTransfer" in the Qonto app on your paired phone. Approve it there within 15 minutes, then confirm here to finish.',
    );
    const { scaSessionToken, idempotencyKey } = question.requestState;
    expect(upstream.calls).toEqual([
      {
        method: "POST",
        url: "https://thirdparty.qonto.com/v2/sepa/transfers",
        idempotencyKey,
        scaSessionToken: undefined,
      },
    ]);

    const respond = (action: "accept" | "decline") =>
      JSON.stringify({
        inputResponses: { approveInQonto: { action } },
        requestState: question.requestState,
      });

    // Not approved yet: the call asks again with the same state.
    upstream.calls.length = 0;
    alice.identity.answer = respond("accept");
    expect(await (await alice.request("/rpc/transfer")).json()).toEqual({
      resultType: "input_required",
      inputRequests: {
        approveInQonto: {
          message: `Qonto has not received your approval yet. ${question.inputRequests.approveInQonto.message}`,
          requestedSchema: { type: "object", properties: {} },
        },
      },
      requestState: question.requestState,
    });
    expect(upstream.calls.map((call) => call.url)).toEqual([
      `https://thirdparty.qonto.com/v2/sca_sessions/${scaSessionToken}`,
    ]);

    // Approved on the phone: the first request runs again with the session attached.
    upstream.state.sessions.set(scaSessionToken, "allow");
    upstream.calls.length = 0;
    expect(await (await alice.request("/rpc/transfer")).json()).toEqual({
      status: "connected",
      data: {
        transfer: {
          id: "transfer-1",
          status: "pending",
          beneficiary_id: "new-beneficiary",
          amount: "120.00",
        },
      },
    });
    expect(upstream.calls).toEqual([
      { method: "GET", url: `https://thirdparty.qonto.com/v2/sca_sessions/${scaSessionToken}` },
      {
        method: "POST",
        url: "https://thirdparty.qonto.com/v2/sepa/transfers",
        idempotencyKey,
        scaSessionToken,
      },
    ]);

    // Repeating the answer creates no second transfer.
    expect(await (await alice.request("/rpc/transfer")).json()).toMatchObject({
      data: { transfer: { id: "transfer-1" } },
    });
    expect(upstream.transfers.size).toBe(1);

    // Declining in Widefleet sends nothing; a refusal on the phone ends the call.
    upstream.calls.length = 0;
    alice.identity.answer = respond("decline");
    expect(await (await alice.request("/rpc/transfer")).json()).toEqual({ status: "declined" });
    expect(upstream.calls).toEqual([]);
    // A rate-limited check says when to try again.
    alice.identity.answer = respond("accept");
    upstream.state.answer = { status: 429, body: null, headers: { "retry-after": "5" } };
    expect(await (await alice.request("/rpc/transfer")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "5",
    });
    upstream.state.sessions.set(scaSessionToken, "deny");
    alice.identity.answer = respond("accept");
    expect(await (await alice.request("/rpc/transfer")).json()).toEqual({
      status: "rejected_in_qonto",
    });
  });

  it("pays trusted beneficiaries without approval in Qonto, each payment with its own key", async () => {
    const alice = browser("alice");
    await connect(alice, "10129");
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toEqual({
      status: "updated",
      level: "none",
    });
    alice.identity.answer = "";
    upstream.calls.length = 0;

    for (const id of ["transfer-1", "transfer-2"])
      expect(
        await (await alice.request("/rpc/transfer?beneficiary=trusted-beneficiary")).json(),
      ).toMatchObject({ status: "connected", data: { transfer: { id } } });

    const keys = upstream.calls.map((call) => call.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => z.uuid().safeParse(key).success)).toBe(true);
  });

  it("keeps one idempotency key through Widefleet's question and honors its answer", async () => {
    const alice = browser("alice");
    await connect(alice, "10129");

    const ask = async () =>
      z
        .object({ requestState: z.object({ idempotencyKey: z.uuid() }) })
        .parse(await (await alice.request("/rpc/transfer?beneficiary=trusted-beneficiary")).json())
        .requestState;

    const answer = (action: "accept" | "decline", state: { idempotencyKey: string }) =>
      JSON.stringify({ inputResponses: { approve: { action } }, requestState: state });

    const state = await ask();
    upstream.calls.length = 0;
    alice.identity.answer = answer("accept", state);

    // The approved request carries the key the question kept, also when the
    // answer comes again after a lost response, so Qonto pays once.
    for (let round = 0; round < 2; round++)
      expect(
        await (await alice.request("/rpc/transfer?beneficiary=trusted-beneficiary")).json(),
      ).toMatchObject({ status: "connected", data: { transfer: { id: "transfer-1" } } });
    expect(upstream.calls.map((call) => call.idempotencyKey)).toEqual([
      state.idempotencyKey,
      state.idempotencyKey,
    ]);
    expect(upstream.transfers.size).toBe(1);

    // A decline stands after the user stops being asked.
    alice.identity.answer = "";
    const next = await ask();
    expect(next.idempotencyKey).not.toBe(state.idempotencyKey);
    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/set-level?level=none")).json()).toMatchObject({
      level: "none",
    });
    upstream.calls.length = 0;
    alice.identity.answer = answer("decline", next);
    expect(
      await (await alice.request("/rpc/transfer?beneficiary=trusted-beneficiary")).json(),
    ).toEqual({ status: "declined" });
    expect(upstream.calls).toEqual([]);
  });

  it("uploads files as multipart parts, one supplier invoice's fields each as its own part", async () => {
    const alice = browser("alice");
    await connect(alice, "10129");
    expect(await (await alice.request("/rpc/upload")).json()).toMatchObject({
      status: "connected",
    });
    expect(upstream.parts).toEqual([
      { name: "file", type: "application/pdf", text: "%PDF-1.7 receipt" },
    ]);
    upstream.parts.length = 0;
    expect(await (await alice.request("/rpc/supplier-invoice")).json()).toMatchObject({
      status: "connected",
    });
    expect(upstream.parts).toEqual([
      { name: "supplier_invoices[][file]", type: "application/pdf", text: "%PDF-1.7 invoice" },
      { name: "supplier_invoices[][idempotency_key]", type: null, text: "invoice-key" },
    ]);
  });

  it("asks before revoking access and runs it only after approval", async () => {
    const alice = browser("alice");
    await connect(alice, "10129");
    upstream.calls.length = 0;

    const asked = z
      .object({ requestState: z.object({ idempotencyKey: z.uuid() }) })
      .passthrough()
      .parse(await (await alice.request("/rpc/revoke")).json());

    expect(asked).toEqual({
      resultType: "input_required",
      inputRequests: {
        approve: {
          message: `Run the Qonto change "revokeAccess"? It deletes or replaces data.\n\nInput:\n${JSON.stringify({}, null, 2)}`,
          requestedSchema: { type: "object", properties: {} },
        },
      },
      requestState: asked.requestState,
    });
    alice.identity.answer = "decline";
    expect(await (await alice.request("/rpc/revoke")).json()).toEqual({ status: "declined" });
    expect(upstream.calls).toEqual([]);

    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/revoke")).json()).toEqual({
      status: "connected",
      data: null,
    });
    expect(upstream.calls.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "DELETE", url: "https://thirdparty.qonto.com/v2/oauth2/consents" },
    ]);
    expect(z.uuid().safeParse(upstream.calls[0]?.idempotencyKey).success).toBe(true);
    // Qonto rejects the saved tokens afterwards, so the connection is removed too.
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connection_required",
    });
    expect(await (await alice.request("/rpc/personal/status")).json()).toMatchObject({
      connection: "disconnected",
    });

    // An account the user connects while Qonto revokes the earlier one stays.
    await connect(alice, "10129");
    const db = await runtime.getD1Database("DB");

    upstream.state.whileRevoking = async () => {
      await db
        .prepare("UPDATE account SET accountId = ? WHERE accountId = ?")
        .bind("membership-10131", "membership-10129")
        .run();
    };

    alice.identity.answer = "accept";
    expect(await (await alice.request("/rpc/revoke")).json()).toMatchObject({
      status: "connected",
    });
    alice.identity.answer = "";
    expect(await (await alice.request("/rpc/personal/status")).json()).toMatchObject({
      connection: "connected",
      account: { id: "membership-10131" },
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
    expect(page).toContain("<strong>member10129@example.test</strong>");
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
    upstream.state.scope = "offline_access organization.read membership.read";
    const alice = browser("alice");
    await connect(alice, "10129");
    upstream.calls.length = 0;

    for (const path of ["/rpc/transactions", "/rpc/status", "/rpc/revoke"])
      expect(await (await alice.request(path)).json()).toMatchObject({
        status: "permission_required",
      });
    expect(upstream.calls).toEqual([]);
    upstream.state.scope = allScopes;
    await connect(alice, "10129");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "connected",
    });
  });

  // Widefleet's My connections page opens a single-use launch link, and the
  // connection returns to Widefleet through a single-use completion link.
  it("connects from Widefleet's launch link and returns there, also when cancelled", async () => {
    const alice = browser("alice");
    const completionUrl = "https://widefleet.example.test/connections?completed=qonto";

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
      .parse(
        (await alice.request(upstream.authorize(destination, "10129"))).headers.get("location"),
      );

    expect(new URL(returned).pathname).toBe("/connect/complete");
    expect((await browser("bob").request(returned)).status).toBe(410);
    const completed = await alice.request(returned);
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe(completionUrl);
    expect((await alice.request(returned)).status).toBe(410);
    expect(await (await alice.request("/rpc/personal/status")).json()).toMatchObject({
      connection: "connected",
      account: { id: "membership-10129" },
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
      accountId: "membership-10129",
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

  it("refreshes rotating tokens, preserves accounts on outages and disconnects only the current user", async () => {
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
      expect(await (await alice.request("/rpc/membership")).json()).toMatchObject({
        status: "connected",
        data: { membership: { id: "membership-10129" } },
      });
      expect(upstream.state.refreshes).toBe(refreshes);
    }

    await expire();
    upstream.state.unavailable = true;
    expect(await (await alice.request("/rpc/membership")).json()).toMatchObject({
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

  it("reports Qonto's errors, rate limits and revoked tokens", async () => {
    const alice = browser("alice");
    await connect(alice, "10129");
    upstream.state.answer = {
      status: 422,
      body: {
        errors: [
          { code: "not_in_list", detail: "status is invalid", source: { parameter: "status" } },
        ],
        trace_id: "6f1a2b3c",
      },
      headers: {},
    };
    expect(await (await alice.request("/rpc/transactions")).json()).toEqual({
      status: "qonto_error",
      error: {
        status: 422,
        errors: [
          { code: "not_in_list", detail: "status is invalid", source: { parameter: "status" } },
        ],
        traceId: "6f1a2b3c",
      },
    });
    // A transfer above the payment policy's threshold names the policy.
    alice.identity.answer = "accept";
    upstream.state.answer = {
      status: 400,
      body: { errors: [{ code: "payment_policy_approval_required" }], trace_id: "7a8b" },
      headers: {},
    };
    expect(await (await alice.request("/rpc/transfer")).json()).toEqual({
      status: "qonto_error",
      error: {
        status: 400,
        errors: [{ code: "payment_policy_approval_required" }],
        traceId: "7a8b",
      },
    });
    // Without a paired phone Qonto cannot ask, and says so.
    upstream.state.answer = {
      status: 428,
      body: { code: "sca_not_enabled", message: "Pair a device to approve this action" },
      headers: {},
    };
    expect(await (await alice.request("/rpc/transfer")).json()).toEqual({
      status: "qonto_error",
      error: {
        status: 428,
        errors: [{ code: "sca_not_enabled", detail: "Pair a device to approve this action" }],
        traceId: null,
      },
    });
    alice.identity.answer = "";
    upstream.state.answer = { status: 429, body: null, headers: { "retry-after": "60" } };
    expect(await (await alice.request("/rpc/transactions")).json()).toEqual({
      status: "rate_limited",
      retryAfter: "60",
    });
    // Larger responses are not read.
    upstream.state.answer = {
      status: 200,
      body: { transactions: [{ id: "1", note: "x".repeat(9 * 1024 * 1024) }] },
      headers: {},
    };
    expect(await (await alice.request("/rpc/transactions")).json()).toEqual({
      status: "too_large",
      maximumBytes: 8 * 1024 * 1024,
    });
    upstream.state.answer = { status: 500, body: null, headers: {} };
    expect((await alice.request("/rpc/transactions")).status).toBe(500);
    // Requests that do not match the operation never reach Qonto.
    upstream.calls.length = 0;
    expect((await alice.request("/rpc/invalid")).status).toBe(500);
    expect(upstream.calls).toEqual([]);
    upstream.state.answer = { status: 401, body: null, headers: {} };
    expect(await (await alice.request("/rpc/transactions")).json()).toMatchObject({
      status: "reconnect_required",
    });
  });
});
