import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startFixture } from "./fixtures/harness.ts";

const browser = (origin: string) => {
  const cookies = new Map<string, string>();

  const request = async (path: string, form?: URLSearchParams, requestOrigin = origin) => {
    const response = await fetch(new URL(path, origin), {
      redirect: "manual",
      method: form ? "POST" : "GET",
      headers: { cookie: [...cookies.values()].join("; "), origin: requestOrigin },
      body: form ?? null,
    });

    for (const header of response.headers.getSetCookie()) {
      const value = header.split(";")[0] ?? "";
      cookies.set(value.split("=")[0] ?? "", value);
    }

    return response;
  };

  return {
    request,
    login: (user: "alice" | "bob") => request("/demo/user", new URLSearchParams({ user })),
  };
};

describe
  .runIf(process.env["RUN_OAUTH_CONNECTOR_TESTS"] === "1")
  .each(["workerd", "celld"] as const)("connector-owned OAuth (%s)", (runtime) => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let alice: ReturnType<typeof browser>;
  let bob: ReturnType<typeof browser>;

  const start = async (client: ReturnType<typeof browser>, target = "issues") => {
    const response = await client.request(
      "/connector/connect",
      new URLSearchParams({ returnTo: `${fixture.origin}/apps/${target}` }),
    );

    expect(response.status, await response.clone().text()).toBe(303);

    return z.string().parse(response.headers.get("location"));
  };

  const authorize = async (location: string, user: "alice" | "bob") => {
    const response = await fetch(location, {
      method: "POST",
      body: new URLSearchParams({ account: user }),
      redirect: "manual",
    });

    expect(response.status, await response.clone().text()).toBe(303);

    return z.string().parse(response.headers.get("location"));
  };

  const connect = async (client: ReturnType<typeof browser>, user: "alice" | "bob") => {
    const callback = await authorize(await start(client), user);
    const response = await client.request(callback);
    expect(response.headers.get("location"), await response.clone().text()).toBe(
      `${fixture.origin}/apps/issues`,
    );
  };

  const issues = async (client: ReturnType<typeof browser>, target = "issues") => {
    const response = await client.request(`/api/apps/${target}`);
    expect(response.status, await response.clone().text()).toBe(200);

    return z
      .object({
        status: z.string(),
        issues: z.array(z.object({ id: z.number(), title: z.string() })),
      })
      .parse(await response.json());
  };

  beforeAll(async () => {
    fixture = await startFixture(runtime);
    alice = browser(fixture.origin);
    bob = browser(fixture.origin);
    await alice.login("alice");
    await bob.login("bob");
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });
  afterEach(({ task }) => {
    if (task.result?.state === "fail") fixture.debug();
  });

  it("reuses one personal connection across apps and isolates users", async () => {
    expect((await issues(alice)).status).toBe("connection_required");
    await connect(alice, "alice");
    expect((await issues(alice)).issues).toEqual([{ id: 101, title: "Issue visible to Alice" }]);
    expect((await issues(alice, "planning")).issues[0]?.id).toBe(101);
    expect(fixture.provider.stats.authorizations).toBe(1);
    expect((await issues(bob)).status).toBe("connection_required");
    await connect(bob, "bob");
    expect((await issues(bob)).issues[0]?.id).toBe(202);
    expect((await issues(alice)).issues[0]?.id).toBe(101);
  });

  it("encrypts tokens in D1 and keeps token APIs private", async () => {
    const accounts = z
      .array(z.object({ accessToken: z.string(), refreshToken: z.string() }))
      .parse(await (await fixture.inspect("accounts")).json());

    expect(accounts).toHaveLength(2);

    for (const account of accounts) {
      expect(account.accessToken).not.toContain("synthetic-access-");
      expect(account.refreshToken).not.toContain("synthetic-refresh-");
      expect(account.accessToken.length).toBeGreaterThan(20);
    }

    for (const path of ["/connector/auth/get-access-token", "/connector/auth/widefleet-session"])
      expect((await alice.request(path, new URLSearchParams())).status).toBe(404);
    expect((await fetch(`${fixture.origin}/_fixture/accounts`)).status).toBe(403);
  });

  it("rejects forged callers, cross-origin connect, changed callers and callback replay", async () => {
    expect(
      (
        await fetch(`${fixture.origin}/api/apps/issues`, {
          headers: { "x-user-id": "alice", cookie: "demo_identity=alice.forged" },
        })
      ).status,
    ).toBe(401);
    const fresh = browser(fixture.origin);
    await fresh.login("alice");
    const callback = await authorize(await start(fresh), "alice");
    await fresh.login("bob");
    expect((await fresh.request(callback)).status).toBe(403);
    await fresh.login("alice");
    expect((await fresh.request(callback)).headers.get("location")).toBe(
      `${fixture.origin}/apps/issues`,
    );
    expect((await fresh.request(callback)).headers.get("location")).not.toBe(
      `${fixture.origin}/apps/issues`,
    );

    const response = await alice.request(
      "/connector/connect",
      new URLSearchParams({ returnTo: `${fixture.origin}/apps/issues` }),
      "https://untrusted.example.test",
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Invalid origin");

    const external = await alice.request(
      "/connector/connect",
      new URLSearchParams({ returnTo: "https://untrusted.example.test/" }),
    );

    expect(external.status, await external.text()).toBe(400);
  });

  it("refreshes expired tokens and preserves connections across worker reloads", async () => {
    expect((await fixture.inspect("expire")).ok).toBe(true);
    expect((await issues(alice)).issues[0]?.id).toBe(101);
    expect((await issues(bob)).issues[0]?.id).toBe(202);
    expect(fixture.provider.stats.refreshes).toBe(2);
    await fixture.reload();
    expect((await issues(alice, "planning")).issues[0]?.id).toBe(101);
    expect((await issues(bob)).issues[0]?.id).toBe(202);
  }, 30_000);

  it("characterizes overlapping rotating-token refreshes and recovery on retry", async () => {
    await fixture.inspect("expire");
    fixture.provider.setRefreshDelay(100);
    const failures = fixture.provider.stats.refreshFailures;

    const responses = await Promise.all([
      alice.request("/api/apps/issues"),
      alice.request("/api/apps/planning"),
    ]);

    fixture.provider.setRefreshDelay(0);

    // This prototype deliberately uses Better Auth's uncoordinated refresh path.
    // The test provider invalidates a refresh token immediately after its first use.
    expect(
      responses.map((response) => response.status).sort((left, right) => left - right),
    ).toEqual([200, 500]);
    expect(fixture.provider.stats.refreshFailures).toBe(failures + 1);
    expect((await issues(alice)).issues[0]?.id).toBe(101);
    expect((await issues(alice, "planning")).issues[0]?.id).toBe(101);
  });

  it("reports revoked access and disconnects only the current user across both apps", async () => {
    fixture.provider.revoke("alice");
    expect((await issues(alice)).status).toBe("reconnect_required");
    expect((await alice.request("/connector/disconnect", new URLSearchParams())).status).toBe(303);
    expect((await issues(alice)).status).toBe("connection_required");
    expect((await issues(alice, "planning")).status).toBe("connection_required");
    expect((await issues(bob)).issues[0]?.id).toBe(202);
  });
});
