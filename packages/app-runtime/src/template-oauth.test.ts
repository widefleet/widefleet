import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { publishedApp } from "@platform/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { oauthProvider } from "../fixtures/oauth-provider.ts";

const appId = "00000000-0000-4000-8000-000000000001";

const root = new URL("../../../", import.meta.url);

const compile = async (file: string) => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(file, root).href)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
  });

  return z.string().parse(result.outputFiles[0]?.text);
};

for (const [template, kind, prefix] of [
  ["gmail", "google", "GOOGLE"],
  ["github", "github", "GITHUB"],
  ["onedrive", "microsoft", "MICROSOFT"],
] as const)
  describe(`${template} managed OAuth`, () => {
    const origin = `https://${template}.example.test:25453`;
    let runtime: Miniflare;
    let upstream: ReturnType<typeof oauthProvider>;
    let script: string;
    let relayScript: string;
    beforeAll(async () => {
      [script, relayScript] = await Promise.all([
        compile(`templates/${template}/tests/worker.ts`),
        compile("packages/app-runtime/fixtures/oauth.ts"),
      ]);
    });

    const configuration = (custom: "none" | "complete" | "partial" = "none") =>
      ({
        telemetry: { enabled: false },
        workers: [
          {
            config: {
              name: "template",
              compatibilityDate: "2026-10-01",
              compatibilityFlags: ["nodejs_compat"],
              manifest: {
                mainModule: "worker.js",
                modules: { "worker.js": { type: "esm", contents: script } },
              },
              env: {
                TEST_OAUTH: { type: "worker", worker: "relay", exportName: "TestOAuth" },
                DB: { type: "d1", id: "accounts" },
                WIDEFLEET_ORIGIN: { type: "json", value: origin },
                [`${prefix}_CLIENT_ID`]: {
                  type: "json",
                  value: custom === "none" ? "" : `test-${kind}-client`,
                },
                [`${prefix}_CLIENT_SECRET`]: {
                  type: "json",
                  value: custom === "complete" ? `test-${kind}-secret` : "",
                },
                AUTH_SECRET: {
                  type: "json",
                  value: "synthetic-secret-with-at-least-32-characters",
                },
              },
            },
            dev: { outboundService: { type: "fetcher", handler: upstream.fetch } },
          },
          {
            config: {
              name: "relay",
              compatibilityDate: "2026-10-01",
              compatibilityFlags: ["nodejs_compat"],
              manifest: {
                mainModule: "worker.js",
                modules: { "worker.js": { type: "esm", contents: relayScript } },
              },
              env: {
                TEST_ORIGIN: { type: "json", value: origin },
                WIDEFLEET_PACKAGES: { type: "r2", name: "catalog" },
                WIDEFLEET_CONTROL_TOKEN: {
                  type: "json",
                  value: "synthetic-control-token-for-local-tests",
                },
                WIDEFLEET_SECRETS_KEY: { type: "json", value: "ab".repeat(32) },
                WIDEFLEET_OAUTH: {
                  type: "json",
                  value: JSON.stringify({
                    origin: "https://oauth.example.test:25453",
                    providers: {
                      [kind]: {
                        clientId: `test-${kind}-client`,
                        clientSecret: `test-${kind}-secret`,
                      },
                    },
                  }),
                },
              },
            },
            dev: { outboundService: { type: "fetcher", handler: upstream.fetch } },
          },
        ],
      }) satisfies MiniflareOptions;

    beforeEach(async () => {
      upstream = oauthProvider(kind);
      runtime = new Miniflare(configuration());
      await runtime.ready;
      const bucket = await runtime.getR2Bucket("WIDEFLEET_PACKAGES", "relay");
      await bucket.put(
        `hosts/${template}.example.test.json`,
        JSON.stringify(
          publishedApp.parse({
            id: appId,
            appId,
            deploymentId: appId,
            version: appId,
            hostname: `${template}.example.test`,
            origin,
            organizationId: "test-org",
            metadata: {
              main_module: "app.js",
              compatibility_date: "2026-10-01",
              assets: { upload_session: appId },
            },
            manifest: {},
            modules: [{ name: "app.js", type: "esm", sha256: "a".repeat(64), size: 1 }],
            nativeBindings: {},
            network: { revision: 1, policy: { backend: [], browser: [] } },
          }),
        ),
      );
    });
    afterEach(async () => {
      await runtime?.dispose();
    });

    const browser = (subject: string) => {
      const cookies = new Map<string, string>();
      const identity = { subject, issuer: "https://identity.example.test" };

      return {
        identity,
        async request(path: string, method = "GET") {
          const url = new URL(path, origin);

          const worker = await runtime.getWorker(
            url.origin === "https://oauth.example.test:25453" ? "relay" : "template",
          );

          const response = await (url.origin === origin
            ? runtime.dispatchFetch(url.href, {
                method,
                redirect: "manual",
                headers: {
                  origin,
                  cookie: [...cookies.values()].join("; "),
                  "test-subject": identity.subject,
                  "test-issuer": identity.issuer,
                },
              })
            : worker.fetch(url.href, {
                method,
                redirect: "manual",
                headers: {
                  "test-subject": identity.subject,
                  "test-issuer": identity.issuer,
                },
              }));

          if (url.origin === origin)
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

      return destination.replace(/&#(\d+);/g, (_, code: string) =>
        String.fromCharCode(Number(code)),
      );
    };

    const connect = async (client: ReturnType<typeof browser>, user: string) => {
      const destination = await start(client);
      let response = await client.request(upstream.authorize(destination, user));
      const location = response.headers.get("location");

      if (location?.includes("managed_state=")) response = await client.request(location);
      expect(response.headers.get("location"), await response.text()).toBe(`${origin}/`);
    };

    const expire = async () => {
      const db = await runtime.getD1Database("DB", "template");
      await db
        .prepare("UPDATE account SET accessTokenExpiresAt = ?")
        .bind(Date.now() - 60000)
        .run();
    };

    it("uses the fixed callback, stores encrypted tokens locally and refreshes through the trusted binding", async () => {
      const alice = browser("alice");
      const destination = new URL(await start(alice));
      expect(destination.searchParams.get("redirect_uri")).toBe(
        `https://oauth.example.test:25453/oauth/callback/${kind}`,
      );
      const relay = await alice.request(upstream.authorize(destination.href, "101"));
      expect(relay.status).toBe(303);
      const returned = z.string().parse(relay.headers.get("location"));
      expect((await browser("alice").request(returned)).status).toBe(403);
      alice.identity.subject = "bob";
      expect((await alice.request(returned)).status).toBe(403);
      alice.identity.subject = "alice";
      expect((await alice.request(returned)).headers.get("location")).toBe(`${origin}/`);
      expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
        status: "connected",
      });
      const db = await runtime.getD1Database("DB", "template");

      const saved = z
        .object({ accessToken: z.string(), refreshToken: z.string() })
        .parse(await db.prepare("SELECT accessToken, refreshToken FROM account").first());

      expect(JSON.stringify(saved)).not.toContain("synthetic-");

      for (let i = 0; i < 2; i++) {
        await expire();
        expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
          status: "connected",
        });
      }

      expect(upstream.state.refreshes).toBe(2);
      expect(await (await browser("bob").request("/rpc/list")).json()).toMatchObject({
        status: "connection_required",
      });
      expect((await alice.request(returned)).headers.get("location")).not.toBe(`${origin}/`);
      await expire();
      upstream.state.unavailable = true;
      expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
        status: "refresh_failed",
      });
      expect(await db.prepare("SELECT COUNT(*) AS count FROM account").first("count")).toBe(1);
      upstream.state.unavailable = false;
      expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
        status: "connected",
      });
      await alice.request("/disconnect", "POST");
      expect(
        await db.prepare("SELECT COUNT(*) AS count FROM oauth_registration").first("count"),
      ).toBe(0);
    });
    it("keeps custom credentials preferred and requires reconnection after changing registration", async () => {
      await runtime.setOptions(configuration("complete"));
      const alice = browser("alice");
      expect(new URL(await start(alice)).searchParams.get("redirect_uri")).toBe(
        `${origin}/auth/callback/${kind}`,
      );
      await connect(alice, "101");
      await runtime.setOptions(configuration());
      expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
        status: "reconnect_required",
      });
      await connect(alice, "101");
      expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
        status: "connected",
      });
      await runtime.setOptions(configuration("complete"));
      expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
        status: "reconnect_required",
      });
      await runtime.setOptions(configuration("partial"));
      expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
        status: "setup_required",
        missing: [`${prefix}_CLIENT_SECRET`],
      });
    });
    it("rejects missing or forged caller proofs and callbacks to deleted apps", async () => {
      const relay = await runtime.getWorker("relay");

      for (const proof of ["", "forged.proof"])
        expect(
          (
            await relay.fetch("https://oauth.example.test:25453/binding", {
              method: "POST",
              headers: { "test-proof": proof },
              body: JSON.stringify({ action: "configuration", provider: kind }),
            })
          ).status,
        ).toBe(403);
      const alice = browser("alice");
      const callback = upstream.authorize(await start(alice), "101");
      const bucket = await runtime.getR2Bucket("WIDEFLEET_PACKAGES", "relay");
      await bucket.put(
        `hosts/${template}.example.test.json`,
        JSON.stringify({ deleted: true, appId }),
      );
      expect((await alice.request(callback)).status).toBe(400);
      expect(upstream.state.exchanges).toBe(0);
    });

    if (kind === "github")
      it("supports GitHub OAuth registrations without expiring tokens", async () => {
        await runtime.setOptions(configuration("complete"));
        const alice = browser("alice");
        await connect(alice, "101");
        await expire();
        await runtime.setOptions(configuration());
        upstream.state.expiring = false;
        await connect(alice, "101");
        expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
          status: "connected",
        });
        expect(upstream.state.refreshes).toBe(0);
      });
  });
