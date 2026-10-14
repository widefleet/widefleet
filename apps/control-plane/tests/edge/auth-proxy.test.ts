import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createIdentityProvider, objectId, tenantId } from "./auth-proxy-idp.ts";
import { createBrowserGateway } from "./auth-proxy-https.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const cookieHeader = (cookies: string[]) =>
  cookies.flatMap((value) => (value.includes("Max-Age=0") ? [] : [value.split(";")[0]])).join("; ");

const echo = z.object({
  method: z.string(),
  body: z.string(),
  headers: z.record(z.string(), z.string()),
});

describe.runIf(process.env["RUN_EDGE_TESTS"] === "1").each(["cloudflare", "celld"])(
  "Better Auth proxy on %s",
  (runtime) => {
    let directory: string;
    let idp: Awaited<ReturnType<typeof createIdentityProvider>>;
    let worker: Awaited<ReturnType<typeof start>>;
    let configuration: ReturnType<typeof config>;
    let sessionCookies: string;

    const config = () => ({
      provider: {
        type: "oidc",
        issuer: idp.origin,
        label: "Company",
        nameClaim: "display_name",
        emailClaim: "mail",
        groupsClaim: "roles",
      },
      clientId: "app-login",
      clientSecret: "synthetic-client-secret",
      cookieSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
      domain: "apps.example.test",
      redirectUrl: "https://auth.apps.example.test/oauth2/callback",
    });

    const start = async (entra = false, target = runtime) => {
      await writeFile(
        join(directory, "wrangler.json"),
        JSON.stringify({
          name: "auth-proxy-test",
          main: "worker.js",
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          vars: {
            CONFIGURATION: JSON.stringify({
              ...configuration,
              provider: entra
                ? { type: "entra", tenantId, authority: idp.origin }
                : configuration.provider,
            }),
            GRAPH_ORIGIN: idp.origin,
          },
        }),
      );

      if (target === "cloudflare") {
        const { unstable_dev } = await import("wrangler");

        const dev = await unstable_dev(join(directory, "worker.js"), {
          config: join(directory, "wrangler.json"),
          local: true,
          persist: false,
          ip: "127.0.0.1",
          port: 0,
          inspectorPort: 0,
          logLevel: "error",
          experimental: {
            disableExperimentalWarning: true,
            disableDevRegistry: true,
            watch: false,
          },
        });

        return { origin: `http://${dev.address}:${dev.port}`, stop: () => dev.stop() };
      }

      const reservation = createServer();

      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const port = z.object({ port: z.number() }).parse(reservation.address()).port;

      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      const origin = `http://127.0.0.1:${port}`;

      const child = spawn(
        join(root, ".tools/celld"),
        ["dev", directory, "--port", String(port), "--no-watch", "--logs"],
        {
          env: { ...process.env, CELLD_SHUTDOWN_TOTAL_MS: "2000" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let output = "";

      for (const source of [child.stdout, child.stderr])
        source.setEncoding("utf8").on("data", (chunk: string) => {
          output = (output + chunk).slice(-16_384);
        });

      const stop = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");

        child.kill("SIGTERM");
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);

        try {
          await exited;
        } finally {
          clearTimeout(timeout);
        }
      };

      try {
        await vi.waitFor(
          async () => {
            if (child.exitCode !== null) throw new Error(output);
            expect((await fetch(`${origin}/.well-known/celld/health`)).ok).toBe(true);
          },
          { timeout: 20_000 },
        );
      } catch (cause) {
        await stop();
        throw cause;
      }

      return { origin, stop };
    };

    const request = (url: string, init: RequestInit = {}) => {
      const target = new URL(url);
      const headers = new Headers(init.headers);

      headers.set("x-fixture-origin", target.origin);

      return fetch(new URL(target.pathname + target.search, worker.origin), {
        ...init,
        headers,
        redirect: "manual",
      });
    };

    const begin = async (destination = "https://ledger.apps.example.test/report?year=2026") => {
      const startUrl = new URL("https://auth.apps.example.test/oauth2/start");

      startUrl.searchParams.set("rd", destination);
      const started = await request(startUrl.href);

      expect(started.status, await started.clone().text()).toBe(302);
      const location = z.url().parse(started.headers.get("location"));
      const authorized = await fetch(location, { redirect: "manual" });

      expect(authorized.status).toBe(302);

      return {
        cookies: cookieHeader(started.headers.getSetCookie()),
        callback: z.url().parse(authorized.headers.get("location")),
        started,
      };
    };

    const login = async (destination?: string) => {
      const flow = await begin(destination);
      const result = await request(flow.callback, { headers: { cookie: flow.cookies } });

      expect(result.status, await result.clone().text()).toBe(302);
      expect(result.headers.get("location")).toBe(
        new URL(destination ?? "https://ledger.apps.example.test/report?year=2026").href,
      );

      return result;
    };

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "auth-proxy-runtimes-"));
      idp = await createIdentityProvider();
      configuration = config();
      await build({
        entryPoints: [fileURLToPath(new URL("auth-proxy-worker.fixture.ts", import.meta.url))],
        outfile: join(directory, "worker.js"),
        bundle: true,
        format: "esm",
        platform: "neutral",
        target: "es2023",
        external: ["node:*"],
      });
      worker = await start();
    }, 30_000);

    beforeEach(() => {
      idp.settings.failure = "";
      idp.settings.available = true;
      idp.settings.name = "Example User";
    });
    afterAll(async () => {
      await worker?.stop();
      await idp?.stop();

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("completes PKCE/nonce login and issues encrypted, one-hour Better Auth cookies", async () => {
      const result = await login();
      const cookies = result.headers.getSetCookie();

      sessionCookies = cookieHeader(cookies);
      const session = cookies.filter((value) => value.includes(".session_"));

      expect(session.length).toBeGreaterThanOrEqual(2);

      for (const value of session) {
        expect(value).toContain("Max-Age=3600");
        expect(value).toContain("Domain=apps.example.test");
        expect(value).toContain("HttpOnly");
        expect(value).toContain("Secure");
        expect(value).toContain("SameSite=Lax");
        expect(value).not.toContain("user@example.test");
        expect(value).not.toContain("fixture-access-token");
      }

      expect(cookies.some((value) => value.includes("account_data"))).toBe(false);
      expect(
        (await request("https://ledger.apps.example.test", { headers: { cookie: sessionCookies } }))
          .status,
      ).toBe(200);
    });

    it("keeps only verified identity headers and strips all app cookies and tokens", async () => {
      const result = await request(
        "https://ledger.apps.example.test/report?allowed_groups=anyone",
        {
          method: "POST",
          body: "example request body",
          headers: {
            cookie: `${sessionCookies}; unrelated=private`,
            authorization: "Bearer secret",
            "proxy-authorization": "Bearer other-secret",
            "x-auth-request-user": "forged",
            "x-auth-request-groups": "administrators",
            "x-auth-request-access-token": "secret",
            "x-forwarded-host": "evil.example.test",
            "x-forwarded-proto": "http",
            forwarded: "host=evil.example.test",
          },
        },
      );

      const forwarded = echo.parse(await result.json());

      expect(forwarded.method).toBe("POST");
      expect(forwarded.body).toBe("example request body");
      expect(forwarded.headers["x-auth-request-user"]).toBe("pairwise-subject");
      expect(forwarded.headers["x-auth-request-preferred-username"]).toBe("Example User");
      expect(forwarded.headers["x-auth-request-email"]).toBe("user@example.test");
      expect(forwarded.headers["x-auth-request-groups"]).toBe("accounting");

      for (const key of [
        "cookie",
        "authorization",
        "proxy-authorization",
        "x-auth-request-access-token",
        "x-forwarded-host",
        "x-forwarded-proto",
        "forwarded",
      ])
        expect(forwarded.headers[key]).toBeUndefined();
      expect(result.headers.getSetCookie()).toEqual([]);
    });

    it("uses the installed rules for flat and nested previews without query/header bypasses", async () => {
      expect(
        (
          await request("https://ledger-pr42.apps.example.test", {
            headers: { cookie: sessionCookies },
          })
        ).status,
      ).toBe(200);

      const denied = await request(
        "https://preview.ledger.apps.example.test/?allowed_groups=accounting",
        {
          headers: { cookie: sessionCookies, "x-auth-request-groups": "reviewers" },
        },
      );

      expect(denied.status).toBe(403);
      expect(
        (
          await request("https://unknown.apps.example.test", {
            headers: { cookie: sessionCookies },
          })
        ).status,
      ).toBe(404);
    });

    it("preserves Unicode names and exact group IDs in the verified identity", async () => {
      idp.settings.name = "Änne 東京";
      const signedIn = await login();

      const result = await request("https://ledger.apps.example.test", {
        headers: { cookie: cookieHeader(signedIn.headers.getSetCookie()) },
      });

      expect(echo.parse(await result.json()).headers["x-auth-request-preferred-username"]).toBe(
        "Änne 東京",
      );
      idp.settings.groups = [" accounting "];

      try {
        const flow = await begin();
        const rejected = await request(flow.callback, { headers: { cookie: flow.cookies } });

        expect(
          rejected.headers
            .getSetCookie()
            .some((value) => value.includes(".session_data") && !value.includes("Max-Age=0")),
        ).toBe(false);
      } finally {
        idp.settings.groups = ["accounting"];
      }
    });

    it("requires login for every app, including apps without group restrictions", async () => {
      expect((await request("https://welcome.apps.example.test")).status).toBe(401);

      const browser = await request("https://welcome.apps.example.test/path?keep=1", {
        headers: { accept: "text/html", "x-auth-request-user": "forged" },
      });

      expect(browser.status).toBe(302);
      expect(
        new URL(z.string().parse(browser.headers.get("location"))).searchParams.get("rd"),
      ).toBe("https://welcome.apps.example.test/path?keep=1");
    });

    it.each([
      "https://evil.example.test",
      "https://apps.example.test.evil.example.test",
      "https://unknown.apps.example.test",
      "https://auth.apps.example.test/oauth2/start",
      "http://ledger.apps.example.test",
      "https://user@ledger.apps.example.test",
      "https://ledger.apps.example.test:444",
    ])("rejects an unregistered or unsafe login destination: %s", async (destination) => {
      expect(
        (
          await request(
            `https://auth.apps.example.test/oauth2/start?rd=${encodeURIComponent(destination)}`,
          )
        ).status,
      ).toBe(400);
    });

    it("does not expose account mutation, token or session endpoints", async () => {
      for (const path of [
        "get-session",
        "update-user",
        "sign-up/email",
        "get-access-token",
        "link-social",
        "callback/company",
      ])
        expect(
          (
            await request(`https://auth.apps.example.test/oauth2/${path}`, {
              headers: { cookie: sessionCookies },
            })
          ).status,
        ).toBe(404);
    });

    it.each(["signature", "issuer", "audience", "nonce", "expired", "email", "missing-token"])(
      "rejects invalid OIDC identity: %s",
      async (failure) => {
        idp.settings.failure = failure;
        const flow = await begin();
        const result = await request(flow.callback, { headers: { cookie: flow.cookies } });

        expect(
          result.headers
            .getSetCookie()
            .some((value) => value.includes(".session_data=") && !value.includes("Max-Age=0")),
        ).toBe(false);
        expect(result.headers.get("location") ?? "").not.toContain("ledger.apps.example.test");
      },
    );

    it("rejects missing and mismatched state cookies before accepting a code", async () => {
      const flow = await begin();
      const other = await begin();

      for (const cookie of ["", other.cookies]) {
        const result = await request(flow.callback, { headers: { cookie } });

        expect(
          result.headers
            .getSetCookie()
            .some((value) => value.includes(".session_data=") && !value.includes("Max-Age=0")),
        ).toBe(false);
        expect(result.headers.get("location") ?? "").not.toContain("ledger.apps.example.test");
      }
    });

    it("rejects tampered, incomplete and shadowed session cookies", async () => {
      const parts = sessionCookies.split("; ");
      const token = z.string().parse(parts.find((value) => value.includes(".session_token=")));
      const data = z.string().parse(parts.find((value) => value.includes(".session_data=")));

      expect(
        (await request("https://welcome.apps.example.test", { headers: { cookie: token } })).status,
      ).toBe(401);
      expect(
        (await request("https://welcome.apps.example.test", { headers: { cookie: data } })).status,
      ).toBe(401);
      expect(
        (
          await request("https://welcome.apps.example.test", {
            headers: { cookie: `${token}; ${data.slice(0, -5)}wrong` },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request("https://welcome.apps.example.test", {
            headers: { cookie: `${sessionCookies}; ${data}` },
          })
        ).status,
      ).toBe(400);
    });

    it("keeps sessions valid after a full runtime restart while the identity provider is unavailable", async () => {
      await worker.stop();
      worker = await start();
      idp.settings.available = false;

      const result = await request("https://ledger.apps.example.test", {
        headers: { cookie: sessionCookies },
      });

      expect(result.status, await result.clone().text()).toBe(200);
      expect(result.headers.getSetCookie()).toEqual([]);
    }, 30_000);

    it("accepts the same sessions on the other runtime and completes a login started before restart", async () => {
      const flow = await begin();

      await worker.stop();
      worker = await start(false, runtime === "cloudflare" ? "celld" : "cloudflare");
      expect(
        (await request("https://ledger.apps.example.test", { headers: { cookie: sessionCookies } }))
          .status,
      ).toBe(200);
      const completed = await request(flow.callback, { headers: { cookie: flow.cookies } });

      expect(completed.headers.get("location")).toBe(
        "https://ledger.apps.example.test/report?year=2026",
      );
      const migrated = cookieHeader(completed.headers.getSetCookie());

      await worker.stop();
      worker = await start();
      expect(
        (await request("https://ledger.apps.example.test", { headers: { cookie: migrated } }))
          .status,
      ).toBe(200);
      const replayed = await request(flow.callback, { headers: { cookie: flow.cookies } });

      expect(replayed.headers.get("location") ?? "").not.toContain("ledger.apps.example.test");
      expect(
        replayed.headers
          .getSetCookie()
          .some((value) => value.includes(".session_data") && !value.includes("Max-Age=0")),
      ).toBe(false);
    }, 30_000);

    it("shares HttpOnly sessions across app hosts in a browser and clears them on sign-out", async () => {
      const gateway = await createBrowserGateway(directory, worker.origin);

      const browser = await chromium.launch({
        args: [`--host-resolver-rules=MAP *.apps.example.test 127.0.0.1:${gateway.port}`],
      });

      try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });

        await context.addCookies([
          {
            name: "__Secure-platform.session_token",
            value: "management",
            domain: "control.example.test",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ]);
        const page = await context.newPage();

        await page.goto("https://ledger.apps.example.test/report");
        await page.waitForURL("https://ledger.apps.example.test/report");
        const received = echo.parse(JSON.parse(await page.locator("body").innerText()));

        expect(received.headers["x-auth-request-user"]).toBe("pairwise-subject");
        expect(received.headers["cookie"]).toBeUndefined();
        expect(await page.evaluate(() => document.cookie)).toBe("");
        const issued = await context.cookies("https://ledger.apps.example.test");

        expect(
          issued.filter((value) => value.name.includes(".session_")).length,
        ).toBeGreaterThanOrEqual(2);
        expect(
          issued.every((value) => value.httpOnly && value.secure && value.sameSite === "Lax"),
        ).toBe(true);
        expect(
          issued.some((value) => value.name.includes("oauth_state") || value.name === "app_cookie"),
        ).toBe(false);
        expect((await page.goto("https://ledger-pr42.apps.example.test"))?.status()).toBe(200);
        expect((await page.goto("https://preview.ledger.apps.example.test"))?.status()).toBe(403);
        await page.goto("https://auth.apps.example.test/oauth2/error");
        expect(
          await page.evaluate(
            async () =>
              (
                await fetch("/oauth2/sign_out", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: "{}",
                })
              ).status,
          ),
        ).toBe(200);
        expect(
          (await context.cookies("https://ledger.apps.example.test")).some((value) =>
            value.name.includes(".session_"),
          ),
        ).toBe(false);
        expect((await context.cookies("https://control.example.test"))[0]?.value).toBe(
          "management",
        );
      } finally {
        await browser.close();
        await gateway.stop();
      }
    }, 30_000);

    it("clears app sessions on sign-out without touching control-plane cookies", async () => {
      const rejected = await request("https://auth.apps.example.test/oauth2/sign_out", {
        method: "POST",
        body: "{}",
        headers: {
          origin: "https://evil.example.test",
          cookie: sessionCookies,
          "content-type": "application/json",
        },
      });

      expect(rejected.status).toBe(403);

      const result = await request("https://auth.apps.example.test/oauth2/sign_out", {
        method: "POST",
        body: "{}",
        headers: {
          origin: "https://auth.apps.example.test",
          cookie: `${sessionCookies}; __Secure-platform.session_token=management`,
          "content-type": "application/json",
        },
      });

      expect(result.status).toBe(200);
      expect(
        result.headers
          .getSetCookie()
          .some(
            (value) =>
              value.startsWith("__Secure-platform_sso.session_data=") &&
              value.includes("Max-Age=0"),
          ),
      ).toBe(true);
      expect(
        result.headers.getSetCookie().some((value) => value.startsWith("__Secure-platform.")),
      ).toBe(false);
    });

    it("resolves Entra overage groups through paginated Graph and carries them across restart", async () => {
      await worker.stop();
      idp.settings.entra = true;
      idp.settings.groups = Array.from(
        { length: 205 },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      worker = await start(true);
      const result = await login("https://welcome.apps.example.test");
      const cookies = result.headers.getSetCookie();

      expect(idp.graphRequests).toHaveLength(3);
      expect(cookies.every((value) => value.length < 4096)).toBe(true);
      expect(cookies.filter((value) => value.includes(".session_data.")).length).toBeGreaterThan(1);
      const header = cookieHeader(cookies);

      await worker.stop();
      worker = await start(true);
      idp.settings.available = false;

      const forwarded = echo.parse(
        await (
          await request("https://welcome.apps.example.test", { headers: { cookie: header } })
        ).json(),
      );

      expect(forwarded.headers["x-auth-request-user"]).toBe(objectId);
      expect(forwarded.headers["x-auth-request-groups"]?.split(",")).toEqual(idp.settings.groups);
    }, 30_000);

    it.each(["tenant", "graph-unavailable", "graph-redirect"])(
      "fails closed for invalid Entra identity or group lookup: %s",
      async (failure) => {
        idp.settings.failure = failure === "tenant" ? failure : "";
        idp.settings.graphFailure = failure.replace("graph-", "");
        const flow = await begin("https://welcome.apps.example.test");
        const result = await request(flow.callback, { headers: { cookie: flow.cookies } });

        expect(
          result.headers
            .getSetCookie()
            .some((value) => value.includes(".session_data") && !value.includes("Max-Age=0")),
        ).toBe(false);
        expect(result.headers.get("location") ?? "").not.toContain("welcome.apps.example.test");
      },
    );
  },
);
