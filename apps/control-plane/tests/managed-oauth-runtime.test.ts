import { build } from "esbuild";
import { Miniflare, Request as WorkerRequest, Response as WorkerResponse } from "miniflare";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { publishedApp } from "@platform/contracts";
import { encodeConfiguration } from "@platform/auth-proxy/publication";
import { expect, it } from "vitest";
import { z } from "zod";
import { runtimeIdentity } from "./runtime-identity.ts";

const root = new URL("../../../", import.meta.url);

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

it("connects through the real loader and refreshes OAuth through a consuming app's binding", async () => {
  const identity = await runtimeIdentity("apps.example.test", [], [], "bob");
  const controlToken = "synthetic-runtime-control-token-for-oauth-tests";
  const appId = crypto.randomUUID();
  const consumerId = crypto.randomUUID();
  const origin = "https://github.apps.example.test";
  const consumerOrigin = "https://consumer.apps.example.test";
  const relayOrigin = "https://oauth.apps.example.test";
  const codes = new Map<string, { redirect: string; challenge: string }>();
  let exchanges = 0;
  let refreshes = 0;
  let accessToken = "synthetic-access-0";
  let refreshToken = "synthetic-refresh-0";

  const provider = async (request: WorkerRequest) => {
    const url = new URL(request.url);

    if (url.href === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(await request.text());
      expect(body.get("client_id")).toBe("synthetic-github-client");
      expect(body.get("client_secret")).toBe("synthetic-github-secret");

      if (body.get("grant_type") === "authorization_code") {
        const code = body.get("code") ?? "";
        const transaction = codes.get(code);
        codes.delete(code);
        expect(transaction).toBeDefined();
        expect(body.get("redirect_uri")).toBe(transaction?.redirect);
        expect(
          createHash("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(transaction?.challenge);
        exchanges++;
      } else {
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe(refreshToken);
        refreshes++;
      }

      accessToken = `synthetic-access-${exchanges}-${refreshes}`;
      refreshToken = `synthetic-refresh-${exchanges}-${refreshes}`;

      return WorkerResponse.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "repo read:user user:email",
      });
    }

    expect(request.headers.get("authorization")).toBe(`Bearer ${accessToken}`);

    if (url.href === "https://api.github.com/user")
      return WorkerResponse.json({
        id: 101,
        login: "alice",
        name: "Alice",
        email: "alice@example.test",
      });

    if (url.href === "https://api.github.com/user/emails")
      return WorkerResponse.json([{ email: "alice@example.test", verified: true, primary: true }]);

    if (url.pathname === "/user/repos") return WorkerResponse.json([]);
    throw new Error(`Unexpected provider request: ${url.href}`);
  };

  const compiled = await build({
    entryPoints: [fileURLToPath(new URL("templates/github/src/app.ts", root))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
  });

  const appSource = z.string().parse(compiled.outputFiles[0]?.text);

  const consumerSource = `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class Consumer extends WorkerEntrypoint {
  async fetch(request) {
    if (new URL(request.url).pathname === '/configuration') return Response.json({
      provider: await this.env.WIDEFLEET_OAUTH.request({action:'configuration',provider:'github'}),
      controlToken: this.env.WIDEFLEET_CONTROL_TOKEN ?? null,
      encryptionKey: this.env.WIDEFLEET_SECRETS_KEY ?? null,
    });
    return Response.json(await this.env.GITHUB.listRepositories());
  }
}`;

  const runtime = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "runtime",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "loader.js",
            modules: {
              "loader.js": {
                type: "esm",
                contents: await readFile(
                  new URL("packages/app-runtime/dist/loader.js", root),
                  "utf8",
                ),
              },
            },
          },
          env: {
            WIDEFLEET_LOADER: { type: "worker-loader" },
            WIDEFLEET_PACKAGES: { type: "r2", name: "packages" },
            AUTH_CONFIG: { type: "kv", id: "auth" },
            NATIVE_DB: { type: "d1", id: "github" },
            WIDEFLEET_CONTROL_TOKEN: { type: "json", value: controlToken },
            WIDEFLEET_SECRETS_KEY: { type: "json", value: "ab".repeat(32) },
            // The existing private management endpoint is used only to seed app secrets.
            WIDEFLEET_MANAGEMENT_HTTP: { type: "json", value: "true" },
            WIDEFLEET_HTTP_AVAILABILITY: { type: "json", value: "kv" },
            WIDEFLEET_CONFIGURATION: { type: "json", value: '{"crons":{},"queues":{}}' },
            WIDEFLEET_OAUTH: {
              type: "json",
              value: JSON.stringify({
                origin: relayOrigin,
                providers: {
                  github: {
                    clientId: "synthetic-github-client",
                    clientSecret: "synthetic-github-secret",
                  },
                },
              }),
            },
          },
        },
        dev: { outboundService: { type: "fetcher", handler: provider } },
      },
    ],
  });

  try {
    await runtime.ready;
    const bucket = await runtime.getR2Bucket("WIDEFLEET_PACKAGES");
    const auth = await runtime.getKVNamespace("AUTH_CONFIG");
    await auth.put(
      "organizations/widefleet/configuration",
      await encodeConfiguration(controlToken, identity.configuration),
    );

    for (const [id, appOrigin, source] of [
      [appId, origin, appSource],
      [consumerId, consumerOrigin, consumerSource],
    ] as const) {
      const app = publishedApp.parse({
        id,
        appId: id,
        organizationId: "widefleet",
        version: crypto.randomUUID(),
        deploymentId: crypto.randomUUID(),
        hostname: new URL(appOrigin).hostname,
        origin: appOrigin,
        secretRevision: 1,
        metadata: {
          main_module: "app.js",
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          web: true,
          entrypoints: ["default"],
          assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
          bindings: id === appId ? [{ type: "d1", name: "DB", database_name: "github" }] : [],
        },
        modules: [
          {
            name: "app.js",
            type: "esm",
            sha256: hash(source),
            size: new TextEncoder().encode(source).length,
          },
        ],
        manifest: {},
        nativeBindings: id === appId ? { DB: "NATIVE_DB" } : {},
        capabilities:
          id === consumerId
            ? {
                GITHUB: {
                  organizationId: "widefleet",
                  app: appId,
                  hostname: new URL(origin).hostname,
                  entrypoint: "default",
                },
              }
            : {},
        network: { revision: 1, policy: { backend: ["https://api.github.com"], browser: [] } },
      });

      await bucket.put(`apps/${id}/modules/${hash(source)}`, source);
      await bucket.put(`hosts/${app.hostname}.json`, JSON.stringify(app));
      await auth.put(
        `apps/${app.hostname}`,
        JSON.stringify({
          organizationId: "widefleet",
          appId: id,
          access: { revision: 1, groups: [] },
        }),
      );
    }

    const seeded = await runtime.dispatchFetch(`${origin}/.well-known/widefleet/app-secrets`, {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}` },
      body: JSON.stringify({
        appId,
        revision: 1,
        values: { AUTH_SECRET: "synthetic-app-secret-at-least-32-characters" },
      }),
    });

    expect(seeded.status, await seeded.text()).toBe(200);

    const cookies = new Map<string, string>();

    const browser = async (url: string, method = "GET") => {
      const templateCookies = new URL(url).origin === origin ? [...cookies.values()] : [];

      const response = await runtime.dispatchFetch(url, {
        method,
        redirect: "manual",
        headers: {
          origin: new URL(url).origin,
          cookie: [identity.cookie, ...templateCookies].join("; "),
        },
      });

      if (new URL(url).origin === origin)
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";")[0] ?? "";
          cookies.set(pair.split("=")[0] ?? "", pair);
        }

      return response;
    };

    const config = await browser(`${consumerOrigin}/configuration`);
    expect(config.status, await config.clone().text()).toBe(200);
    expect(await config.json()).toEqual({
      provider: { clientId: "synthetic-github-client" },
      controlToken: null,
      encryptionKey: null,
    });
    expect(await (await browser(consumerOrigin)).json()).toMatchObject({
      status: "connection_required",
    });
    const started = await browser(`${origin}/connect`, "POST");
    const page = await started.text();
    expect(started.status, page).toBe(200);

    const location = z
      .string()
      .parse(/<a href="([^"]+)">/.exec(page)?.[1])
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

    const authorization = new URL(location);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${relayOrigin}/oauth/callback/github`,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const code = crypto.randomUUID();
    codes.set(code, {
      redirect: `${relayOrigin}/oauth/callback/github`,
      challenge: z.string().parse(authorization.searchParams.get("code_challenge")),
    });
    const callback = new URL(`${relayOrigin}/oauth/callback/github`);
    callback.searchParams.set("state", z.string().parse(authorization.searchParams.get("state")));
    callback.searchParams.set("code", code);
    const relayed = await browser(callback.href);
    expect(relayed.status).toBe(303);
    const returned = await browser(z.string().parse(relayed.headers.get("location")));
    expect(returned.headers.get("location"), await returned.text()).toBe(`${origin}/`);
    expect(await (await browser(consumerOrigin)).json()).toMatchObject({
      status: "connected",
      repositories: [],
    });
    const db = await runtime.getD1Database("NATIVE_DB");

    for (let attempt = 0; attempt < 2; attempt++) {
      await db
        .prepare("UPDATE account SET accessTokenExpiresAt = ?")
        .bind(Date.now() - 60000)
        .run();
      expect(await (await browser(consumerOrigin)).json()).toMatchObject({
        status: "connected",
        repositories: [],
      });
    }

    expect(exchanges).toBe(1);
    expect(refreshes).toBe(2);

    const bob = await runtime.dispatchFetch(consumerOrigin, {
      headers: { cookie: z.string().parse(identity.otherCookie), "x-auth-request-user": "alice" },
    });

    expect(await bob.json()).toMatchObject({ status: "connection_required" });

    const anonymous = await runtime.dispatchFetch(consumerOrigin, {
      redirect: "manual",
      headers: { "x-auth-request-user": "alice" },
    });

    expect(anonymous.status).toBe(401);
    expect(refreshes).toBe(2);
  } finally {
    await runtime.dispose();
  }
}, 30000);
