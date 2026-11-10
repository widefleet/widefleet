import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provider } from "./provider.ts";

const module = new URL("../src/app.ts", import.meta.url);

const kind = "microsoft";

describe(`${kind} personal account app`, () => {
  const origin = `https://${kind}.example.test:25453`;
  const prefix = "MICROSOFT";
  let runtime: Miniflare;
  let upstream: ReturnType<typeof provider>;
  let script: string;
  beforeAll(async () => {
    const result = await build({
      stdin: {
        resolveDir: dirname(fileURLToPath(module.href)),
        contents: `import App from ${JSON.stringify(`./${basename(fileURLToPath(module.href))}`)};
          import { WorkerEntrypoint } from "cloudflare:workers";
          export class TestApp extends App {
            constructor(ctx, env) { super(ctx, { ...env, WIDEFLEET_SECRETS: { get: async (name) => {
              if (!env[name]) throw new Error("App secret is not configured");
              return env[name];
            } } }); }
          }
          export default class Host extends WorkerEntrypoint {
            async fetch(request) {
              const subject = request.headers.get("test-subject");
              const app = this.ctx.exports.TestApp({ props: { caller: subject ? {
                subject, issuer: request.headers.get("test-issuer") ?? "https://identity.example.test", name: subject
              } : null } });
              const path = new URL(request.url).pathname;
              if (path === "/rpc/status") return Response.json(await app.connectionStatus());
              if (path === "/rpc/list") return Response.json(await app.listFiles());
              if (path === "/rpc/content") return Response.json(await app.getDownloadUrl("file"));
              return app.fetch(request);
            }
          }`,
      },
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
              [`${prefix}_CLIENT_ID`]: {
                type: "json",
                value: configured ? `test-${kind}-client` : "",
              },
              [`${prefix}_CLIENT_SECRET`]: {
                type: "json",
                value: configured ? `test-${kind}-secret` : "",
              },
              AUTH_SECRET: {
                type: "json",
                value: configured ? "synthetic-secret-with-at-least-32-characters" : "",
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
    const identity = { subject, issuer: "https://identity.example.test" };

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

  it("shows missing settings before setup without attempting OAuth", async () => {
    await runtime.setOptions(configuration(false));
    const alice = browser("alice");
    expect(await (await alice.request("/rpc/status")).json()).toMatchObject({
      status: "setup_required",
      missing: [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`, "AUTH_SECRET"],
    });
    const page = await (await alice.request("/")).text();
    expect(page).toContain(`/auth/callback/${kind}`);
    expect((await alice.request("/connect", "POST")).headers.get("location")).toBe("/");
  });
  it("links, reads, encrypts tokens and isolates users and identity issuers", async () => {
    const alice = browser("alice");
    const bob = browser("bob");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connection_required",
    });
    await connect(alice, "101");
    expect(await (await alice.request("/rpc/list")).json()).toMatchObject({
      status: "connected",
    });
    const download = await alice.request("/rpc/content");
    const downloaded = await download.text();
    expect(download.status, downloaded).toBe(200);
    const content: object = z.object().passthrough().parse(JSON.parse(downloaded));
    expect(content).toMatchObject({ status: "connected" });
    {
      expect(content).toMatchObject({
        url: "https://download.example.test/file?token=synthetic",
      });
      expect(upstream.state.downloads).toBe(0);
    }

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

    expect(saved.accessToken).not.toContain("synthetic-access-");
    expect(saved.refreshToken).not.toContain("synthetic-refresh-");
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
});
