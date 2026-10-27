import { authConfiguration, createAuthProxy } from "@platform/auth-proxy";
import { createGoogleDirectory } from "@platform/auth-proxy/google-directory";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createIdentityProvider } from "./auth-proxy-idp.ts";

const app = "https://ledger.apps.example.test/";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .flatMap((value) => (value.includes("Max-Age=0") ? [] : [value.split(";")[0]]))
    .join("; ");

describe("Google Workspace app identity", () => {
  let idp: Awaited<ReturnType<typeof createIdentityProvider>>;
  let configuration: z.infer<typeof authConfiguration>;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  const calls: URL[] = [];
  let memberships = ["group-accounting", "group-auditors"];
  let directoryStatus = 200;
  let workspaceDomain = "example.test";

  const apps = {
    resolve: (hostname: string) =>
      Promise.resolve(
        hostname === new URL(app).hostname ? { revision: 0, groups: ["group-accounting"] } : null,
      ),
    fetch: (request: Request) =>
      Promise.resolve(Response.json(Object.fromEntries(request.headers))),
  };

  beforeAll(async () => {
    idp = await createIdentityProvider();
    keys = await generateKeyPair("RS256", { extractable: true });
    configuration = authConfiguration.parse({
      organizationId: "widefleet",
      provider: { type: "google", domain: "example.test" },
      clientId: "app-login",
      clientSecret: "synthetic-client-secret",
      cookieSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
      domain: "apps.example.test",
      redirectUrl: "https://auth.apps.example.test/oauth2/widefleet/callback",
      directory: {
        clientId: "directory@fixture.iam.gserviceaccount.com",
        adminEmail: "admin@example.test",
        clientSecret: await exportPKCS8(keys.privateKey),
      },
    });
  });

  beforeEach(() => {
    idp.settings.google = true;
    idp.settings.workspaceDomain = "example.test";
    idp.settings.failure = "";
    calls.length = 0;
    memberships = ["group-accounting", "group-auditors"];
    directoryStatus = 200;
    workspaceDomain = "example.test";
    const originalFetch = globalThis.fetch;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.origin === "https://accounts.google.com")
        return originalFetch(new Request(new URL(url.pathname, idp.origin), request));

      if (url.origin === "https://oauth2.googleapis.com") {
        const form = new URLSearchParams(await request.text());

        const assertion = await jwtVerify(z.string().parse(form.get("assertion")), keys.publicKey, {
          audience: "https://oauth2.googleapis.com/token",
          issuer: "directory@fixture.iam.gserviceaccount.com",
        });

        expect(assertion.payload.sub).toBe("admin@example.test");
        expect(assertion.payload["scope"]).toBe(
          "https://www.googleapis.com/auth/admin.directory.group.readonly",
        );

        return Response.json({ access_token: "synthetic-directory-token", expires_in: 3600 });
      }

      if (url.origin === "https://admin.googleapis.com") {
        calls.push(url);
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-directory-token");

        if (directoryStatus !== 200)
          return new Response(null, { status: directoryStatus, headers: { "retry-after": "7" } });
        const offset = Number(url.searchParams.get("pageToken") || "0");

        return Response.json({
          groups: memberships.slice(offset, offset + 1).map((id) => ({ id, name: id })),
          nextPageToken: offset + 1 < memberships.length ? String(offset + 1) : undefined,
        });
      }

      return originalFetch(request);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await idp.stop();
  });

  const login = async () => {
    idp.settings.workspaceDomain = workspaceDomain;
    const proxy = createAuthProxy(configuration, apps);

    const started = await proxy.fetch(
      new Request(
        `https://auth.apps.example.test/oauth2/widefleet/start?rd=${encodeURIComponent(app)}`,
      ),
    );

    const location = new URL(z.string().parse(started.headers.get("location")));

    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("hd")).toBe("example.test");
    expect(location.searchParams.get("scope")).not.toContain("offline_access");
    const authorized = await fetch(location, { redirect: "manual" });

    return proxy.fetch(
      new Request(z.string().parse(authorized.headers.get("location")), {
        headers: { cookie: cookies(started) },
      }),
    );
  };

  const visit = (cookie: string) =>
    createAuthProxy(configuration, apps).fetch(new Request(app, { headers: { cookie } }));

  const expire = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
  };

  it("loads all membership pages and rechecks groups when the provider token expires", async () => {
    const signedIn = await login();

    expect(signedIn.headers.get("location")).toBe(app);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.get("userKey")).toBe("pairwise-subject");
    const cookie = cookies(signedIn);
    const allowed = await visit(cookie);

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      "x-auth-request-groups": "group-accounting,group-auditors",
    });
    expect(calls).toHaveLength(2);
    memberships = ["group-auditors"];
    expire();
    const denied = await visit(cookie);

    expect(denied.status).toBe(403);
    expect(denied.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(calls).toHaveLength(3);
  });

  it.each(["other-company.test", ""])(
    "rejects the Workspace domain %s before directory access",
    async (domain) => {
      workspaceDomain = domain;
      expect((await login()).headers.get("location")).not.toBe(app);
      expect(calls).toHaveLength(0);
    },
  );

  it("retains cookies through directory throttling and recovers on the next request", async () => {
    const cookie = cookies(await login());
    expire();
    directoryStatus = 429;
    const unavailable = await visit(cookie);

    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("7");
    expect(cookies(unavailable)).toContain(".account_data=");
    expect(cookies(unavailable)).not.toContain(".session_data=");
    directoryStatus = 200;
    expect((await visit(cookie)).status).toBe(200);
  });

  it("uses the same directory credentials for group-name search", async () => {
    const directory = createGoogleDirectory(
      z
        .object({ clientId: z.string(), clientSecret: z.string(), adminEmail: z.string() })
        .parse(configuration.directory),
    );

    const result = await directory.search({ query: "Accounting", limit: 1 });

    expect(result.groups[0]?.id).toBe("group-accounting");
    expect(result.hasMore).toBe(true);
    expect(calls[0]?.searchParams.get("query")).toBe("name:'Accounting'*");
    expect(calls[0]?.searchParams.get("customer")).toBe("my_customer");
  });
});
