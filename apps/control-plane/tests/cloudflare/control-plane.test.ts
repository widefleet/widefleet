import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Unstable_DevWorker } from "wrangler";
import {
  chromium,
  expect as browserExpect,
  request,
  type APIRequestContext,
} from "@playwright/test";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { z } from "zod";
import { createAuthentication } from "../../src/lib/server/auth.ts";
import { apiResource, cliClientId } from "../../src/lib/server/auth-options.ts";
import { hashAsset } from "../../src/lib/server/asset-hash.ts";
import { invitation, ssoProvider, session } from "../../src/lib/server/auth-schema.ts";
import { appLoginClientId, registerAppLogin } from "../../src/lib/server/app-login-client.ts";
import { appCallbackUrl } from "../../src/lib/server/app-sign-in.ts";
import { installationOrganizationId } from "../../src/lib/organization.ts";
import { generateKeyPair, SignJWT } from "jose";
import { eq, sql } from "drizzle-orm";
import { installation } from "../../src/lib/server/schema.ts";
import { installationId, readInstallation } from "../../src/lib/server/installation-store.ts";
import { initializeCloudflareRuntime } from "../../src/lib/server/organization-runtime.ts";
import { recordInstallationRuntime } from "../cloudflare-deployment.fixture.ts";
import { createTestEnvironment } from "../environment.ts";
import { editableSettings } from "../settings-input.ts";
import { observeOAuthResourceWrites } from "../oauth-resource-writes.ts";
import { expectRateLimitedBurst } from "../rate-limit.ts";

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")("Cloudflare control plane", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let directory: string;
  let worker: Unstable_DevWorker;
  let administrator: APIRequestContext;
  let resourceWrites: Awaited<ReturnType<typeof observeOAuthResourceWrites>>;
  const origin = "http://127.0.0.1:25460";

  beforeAll(async () => {
    environment = await createTestEnvironment(origin, "oidc");
    await environment.database.db.update(ssoProvider).set({ domainVerified: true });
    resourceWrites = await observeOAuthResourceWrites(environment.database.db);
    (await initializeCloudflareRuntime(environment.database.db)).unwrap();
    // The Worker records this reference for deployments and never reads the package here.
    await recordInstallationRuntime(environment.database.db, { put: async () => Result.ok() });
    directory = await mkdtemp(join(tmpdir(), "widefleet-cloudflare-"));
    const { unstable_dev, unstable_readConfig } = await import("wrangler");

    const configuration = z
      .object({
        main: z.string(),
        compatibility_date: z.string(),
        compatibility_flags: z.array(z.string()),
        vars: z.record(z.string(), z.string()),
        ratelimits: z.array(
          z.object({
            name: z.string(),
            namespace_id: z.string(),
            simple: z.object({ limit: z.number(), period: z.number() }),
          }),
        ),
      })
      .parse(
        unstable_readConfig({
          config: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
        }),
      );

    const entry = join(directory, "fixture.ts");
    await writeFile(
      entry,
      `
      import application from ${JSON.stringify(configuration.main)};
      import { manageAuthConfiguration } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@platform/auth-proxy/worker")))};
      import { WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers';
      export class AppRuntime extends WorkerEntrypoint {
        fetch(request) {
          return manageAuthConfiguration(request, { AUTH_CONFIG: this.env.AUTH_CONFIG, WIDEFLEET_CONTROL_TOKEN: this.env.WIDEFLEET_CONTROL_TOKEN });
        }
      }
      export class AcceptedDeployment extends WorkflowEntrypoint {
        async run(event, step) { await step.sleep('pending', '1 day'); }
      }
      const events = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        const request = new Request(input, options);
        // The synthetic authorization code is the ID token Microsoft would return.
        if (request.url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
          const code = new URLSearchParams(await request.text()).get('code');
          return Response.json({ access_token: 'synthetic', id_token: code, token_type: 'Bearer', expires_in: 300 });
        }
        if (new URL(request.url).origin === 'https://eu.i.posthog.com') {
          const body = request.headers.get('content-encoding') === 'gzip'
            ? request.body.pipeThrough(new DecompressionStream('gzip')) : request.body;
          events.push(...(await new Response(body).json()).batch);
          return new Response('{}', {status:503});
        }
        return originalFetch(request);
      };
      export default {...application, fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/fixture-exceptions') return Response.json(events);
        return application.fetch(request, env, ctx);
      }};
    `,
    );
    const path = join(directory, "wrangler.json");
    await writeFile(
      path,
      JSON.stringify({
        name: "widefleet-control-plane-test",
        main: entry,
        compatibility_date: configuration.compatibility_date,
        compatibility_flags: configuration.compatibility_flags,
        ratelimits: configuration.ratelimits,
        assets: {
          directory: fileURLToPath(new URL("../../dist/cloudflare/public", import.meta.url)),
          binding: "ASSETS",
        },
        vars: {
          ...configuration.vars,
          ...environment.environment,
          LOGIN_CODE_DELIVERY: "console",
          WIDEFLEET_CONTROL_TOKEN: "local-control-plane-auth-key-never-deploy",
          APP_COOKIE_SECRET: Buffer.alloc(32, 1).toString("base64url"),
        },
        services: [
          {
            binding: "APP_RUNTIME",
            service: "widefleet-control-plane-test",
            entrypoint: "AppRuntime",
          },
        ],
        kv_namespaces: [{ binding: "AUTH_CONFIG", id: "auth-config" }],
        workflows: [
          { binding: "DEPLOYMENTS", name: "fixture-deployments", class_name: "AcceptedDeployment" },
        ],
        hyperdrive: [
          {
            binding: "HYPERDRIVE",
            id: "00000000000000000000000000000000",
            localConnectionString: environment.environment.DATABASE_URL,
          },
        ],
        r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "artifacts" }],
      }),
    );
    worker = await unstable_dev(entry, {
      config: path,
      local: true,
      persist: false,
      ip: "127.0.0.1",
      port: 25460,
      inspectorPort: 0,
      logLevel: "error",
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });
    administrator = await request.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });

    let code = "";

    const auth = createAuthentication(environment.configuration, environment.database.db, {
      sendEmail: async ({ text }) => {
        code = text.match(/\b\d{6}\b/)?.[0] ?? "";
      },
    });

    await auth.api.sendVerificationOTP({
      body: { email: environment.owner.email, type: "sign-in" },
    });

    const signedIn = await administrator.post("/api/auth/sign-in/email-otp", {
      data: { email: environment.owner.email, otp: code },
    });

    expect(await signedIn.json()).toMatchObject({ user: { id: environment.owner.id } });
    expect(signedIn.status()).toBe(200);
    await environment.database.db
      .update(session)
      .set({ identityOrganizationId: "widefleet" })
      .where(eq(session.userId, environment.owner.id));
  }, 60_000);

  afterAll(async () => {
    await administrator?.dispose();
    await worker?.stop();
    await environment?.close();

    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reports initialization errors without an available request runtime", async () => {
    const { unstable_dev } = await import("wrangler");

    const broken = await unstable_dev(join(directory, "fixture.ts"), {
      config: join(directory, "wrangler.json"),
      local: true,
      persist: false,
      ip: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      logLevel: "error",
      vars: {
        BETTER_AUTH_SECRET: "too-short",
        POSTHOG_PROJECT_TOKEN: "phc_synthetic",
        POSTHOG_ORIGIN: origin,
      },
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });

    try {
      expect((await broken.fetch(`${origin}/healthz`)).status).toBe(500);
      await expect
        .poll(async () => {
          const response = await broken.fetch(`${origin}/fixture-exceptions`);

          return z
            .array(z.object({ event: z.string(), distinct_id: z.string() }))
            .parse(await response.json());
        })
        .toEqual([{ event: "$exception", distinct_id: "installation:control-plane" }]);
    } finally {
      await broken.stop();
    }
  }, 30000);

  it("serves management requests from workerd through the local Hyperdrive binding", async () => {
    const response = await fetch(`${origin}/healthz`);
    expect(await response.text()).toContain('"status":"ok"');
    expect(response.status).toBe(200);
  });

  it("asks search engines not to index Worker pages and API responses", async () => {
    for (const path of ["/sign-in", "/healthz", "/api/v1/apps"]) {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex");
    }
  });

  it("renews browser session cookies through the Worker page response", async () => {
    const state = await administrator.storageState();

    const current = await environment.auth.api.getSession({
      headers: new Headers({
        cookie: state.cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
      }),
    });

    if (!current) throw new Error("Expected administrator session");
    const lifetime = 7 * 24 * 60 * 60;
    const previousExpiry = new Date(Date.now() + (lifetime - 25 * 60 * 60) * 1000);
    await environment.database.db
      .update(session)
      .set({ expiresAt: previousExpiry })
      .where(eq(session.id, current.session.id));

    const client = await request.newContext({
      baseURL: origin,
      storageState: {
        ...state,
        cookies: state.cookies.map((cookie) => ({
          ...cookie,
          expires: Math.floor(previousExpiry.getTime() / 1000),
        })),
      },
    });

    try {
      const response = await client.get("/organizations");
      expect(response.status()).toBe(200);
      const { authCookies } = await environment.auth.$context;

      const renewed = (await client.storageState()).cookies.find(
        (cookie) => cookie.name === authCookies.sessionToken.name,
      );

      if (!renewed) throw new Error("Expected renewed browser cookie");
      expect(renewed.expires - Date.now() / 1000).toBeGreaterThan(lifetime - 10);

      const [stored] = await environment.database.db
        .select({ expiresAt: session.expiresAt })
        .from(session)
        .where(eq(session.id, current.session.id));

      if (!stored) throw new Error("Expected persisted session");
      expect(Math.abs(renewed.expires - stored.expiresAt.getTime() / 1000)).toBeLessThan(2);
    } finally {
      await client.dispose();
    }
  });

  it("handles a bodyless CLI discovery start before rejecting a non-Cloud installation", async () => {
    // workerd exposes a body stream even for this empty POST. The Node adapter
    // omits it, which previously hid Better Auth's 415 response without Content-Type.
    const response = await fetch(`${origin}/api/auth/cli-login/start`, {
      method: "POST",
      headers: { origin },
    });

    expect(response.status, await response.clone().text()).toBe(404);
  });

  it("starts Cloud discovery without Content-Type and polls the persisted request", async () => {
    const cloudOrigin = "https://app.widefleet.com";
    const { unstable_dev } = await import("wrangler");

    const cloud = await unstable_dev(join(directory, "fixture.ts"), {
      config: join(directory, "wrangler.json"),
      vars: { PLATFORM_URL: cloudOrigin },
      local: true,
      persist: false,
      ip: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      logLevel: "error",
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });

    try {
      const response = await cloud.fetch(`${cloudOrigin}/api/auth/cli-login/start`, {
        method: "POST",
        headers: { origin: cloudOrigin },
      });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");

      const started = z
        .object({ request_id: z.string(), cli_token: z.string(), verification_uri: z.string() })
        .parse(await response.json());

      expect(new URL(started.verification_uri).origin).toBe(cloudOrigin);

      const polled = await cloud.fetch(`${cloudOrigin}/api/auth/cli-login/poll`, {
        method: "POST",
        headers: { origin: cloudOrigin, "content-type": "application/json" },
        body: JSON.stringify({ request_id: started.request_id, cli_token: started.cli_token }),
      });

      expect(polled.status, await polled.clone().text()).toBe(200);
      expect(await polled.json()).toEqual({ platform_url: null });
    } finally {
      await cloud.stop();
    }
  }, 30_000);

  it("limits login attempts across independent Worker requests for the same IP", async () => {
    const signIn = (ip: string) =>
      fetch(`${origin}/api/auth/sign-in/email-otp`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "cf-connecting-ip": ip,
          "x-forwarded-for": crypto.randomUUID(),
        },
        body: JSON.stringify({
          email: environment.owner.email,
          otp: "000000",
        }),
      });

    const admitted = await expectRateLimitedBurst(() => signIn("192.0.2.50"), {
      max: 3,
      window: 60,
      clockAligned: true,
      admittedStatus: 400,
    });

    for (const response of admitted) {
      expect(await response.json()).toMatchObject({ code: "INVALID_OTP" });
    }

    const otherIp = await signIn("192.0.2.51");
    expect(otherIp.status).toBe(400);
    expect(await otherIp.json()).toMatchObject({ code: "INVALID_OTP" });
  });

  it("publishes saved app sign-in settings through the auth proxy service binding", async () => {
    const response = await administrator.get("/api/v1/settings");
    expect(response.status()).toBe(200);
    const initial = contract.settingsView.parse(await response.json());
    expect(initial.error).toBeNull();

    const plan = await administrator.post("/api/v1/settings/plan", {
      data: editableSettings(initial),
    });

    expect(plan.status()).toBe(200);
    expect(await plan.json()).toMatchObject({ restartRequired: false });

    const saved = await administrator.put("/api/v1/settings", { data: editableSettings(initial) });
    expect(saved.status()).toBe(200);
    const result = contract.settingsView.parse(await saved.json());
    expect(result.error).toBeNull();
    expect(result.activation).toMatchObject({
      state: "active",
      revision: initial.activation.revision,
    });
    expect(result.activation.message).toContain("KV propagation");
    expect(await (await administrator.get("/api/v1/settings")).json()).toMatchObject({
      activation: result.activation,
    });
  });

  // Starts an app authorization while signed out, as the app sign-in proxy does.
  const startAppSignIn = async (baseURL: string) => {
    await registerAppLogin(
      environment.database.db,
      environment.configuration,
      z.string().parse(environment.configuration.PLATFORM_ENCRYPTION_KEY),
      installationOrganizationId,
    );

    // Node's fetch replaces Sec-Fetch-Mode, so drive the browser navigation with Playwright.
    const browser = await request.newContext({
      baseURL,
      extraHTTPHeaders: { origin },
      maxRedirects: 0,
    });

    try {
      const navigate = (path: string) =>
        browser.get(path, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } });

      const redirectUri = appCallbackUrl(environment.configuration, installationOrganizationId);

      const authorization = await navigate(
        `/api/auth/oauth2/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: appLoginClientId(installationOrganizationId),
          redirect_uri: redirectUri,
          scope: "openid profile email offline_access",
          state: "synthetic-app-state",
          code_challenge: "zMTu4U_d3LvcnIJF0MLJksW3cZ-uah6k4pEKpX9Ay6s",
          code_challenge_method: "S256",
        })}`,
      );

      const login = new URL(z.string().parse(authorization.headers()["location"]), origin);
      expect(login.pathname).toBe("/sign-in");

      return {
        browser,
        // The sign-in page sends this through the OAuth provider client plugin.
        oauthQuery: login.search.slice(1),
        expectResumed: async (callbackPath: string) => {
          const callback = await navigate(callbackPath);
          const destination = new URL(z.string().parse(callback.headers()["location"]), origin);
          expect(destination.origin + destination.pathname).toBe(redirectUri);
          expect(destination.searchParams.get("state")).toBe("synthetic-app-state");
          expect(destination.searchParams.get("code")).toBeTruthy();
        },
      };
    } catch (cause) {
      await browser.dispose();
      throw cause;
    }
  };

  it("resumes a pending app sign-in after a new user signs in with Microsoft", async () => {
    const { unstable_dev } = await import("wrangler");
    const email = `invited-${crypto.randomUUID()}@social.example`;
    await environment.database.db.insert(invitation).values({
      id: crypto.randomUUID(),
      organizationId: installationOrganizationId,
      email,
      role: "member",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      inviterId: environment.owner.id,
    });

    const social = await unstable_dev(join(directory, "fixture.ts"), {
      config: join(directory, "wrangler.json"),
      vars: { MICROSOFT_CLIENT_ID: "synthetic-microsoft", MICROSOFT_CLIENT_SECRET: "synthetic" },
      local: true,
      persist: false,
      ip: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      logLevel: "error",
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });

    try {
      const app = await startAppSignIn(`http://127.0.0.1:${social.port}`);

      try {
        const started = await app.browser.post("/api/auth/sign-in/social", {
          data: {
            provider: "widefleet-microsoft",
            callbackURL: "/",
            newUserCallbackURL: "/organizations?next=%2Fwelcome",
            disableRedirect: true,
            oauth_query: app.oauthQuery,
          },
        });

        expect(started.status(), await started.text()).toBe(200);
        const provider = new URL(z.object({ url: z.string() }).parse(await started.json()).url);
        const { privateKey } = await generateKeyPair("RS256");

        const idToken = await new SignJWT({
          name: "Invited member",
          email,
          xms_edov: true,
          oid: crypto.randomUUID(),
          tid: crypto.randomUUID(),
        })
          .setProtectedHeader({ alg: "RS256" })
          .setSubject(crypto.randomUUID())
          .setAudience("synthetic-microsoft")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);

        await app.expectResumed(
          `/api/auth/callback/widefleet-microsoft?${new URLSearchParams({
            state: z.string().parse(provider.searchParams.get("state")),
            code: idToken,
          })}`,
        );
      } finally {
        await app.browser.dispose();
      }
    } finally {
      await social.stop();
    }
  }, 30_000);

  it("resumes a pending app sign-in after company SSO", async () => {
    const [company] = await environment.database.db
      .select({ providerId: ssoProvider.providerId })
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, installationOrganizationId));

    if (!company) throw new Error("Expected the installation SSO provider");
    const app = await startAppSignIn(origin);

    try {
      const started = await app.browser.post("/api/auth/sign-in/sso", {
        data: { providerId: company.providerId, callbackURL: "/", oauth_query: app.oauthQuery },
      });

      expect(started.status(), await started.text()).toBe(200);
      const { url } = z.object({ url: z.url() }).parse(await started.json());
      const authorization = new URL(url);

      // Choose the seeded user on the test identity provider's account picker.
      const authorized = await fetch(new URL("/oauth2/v2.0/authorize/callback", authorization), {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({
          ...Object.fromEntries(authorization.searchParams),
          email: "sso@example.test",
        }),
      });

      const callback = new URL(z.url().parse(authorized.headers.get("location")));

      await app.expectResumed(callback.pathname + callback.search);
    } finally {
      await app.browser.dispose();
    }
  }, 30_000);

  it("keeps sessions and PostgreSQL connections scoped correctly across concurrent requests", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => administrator.get("/api/v1/me")),
    );

    for (const response of responses) {
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ id: environment.owner.id });
    }

    expect((await fetch(`${origin}/api/v1/me`)).status).toBe(401);

    const rejected = await administrator.post("/api/v1/apps", {
      headers: { origin: "https://untrusted.example.test" },
      data: { slug: "untrusted", displayName: "Untrusted" },
    });

    expect(rejected.status()).toBe(403);
    expect(await resourceWrites()).toBe(0);
  });

  it("persists device authorization and token refresh across independent Worker requests", async () => {
    for (const scope of ["unknown:scope", "openid platform:read unknown:scope"]) {
      const rejected = await administrator.post("/api/auth/device/code", {
        form: {
          client_id: cliClientId,
          scope,
          resource: apiResource(environment.configuration),
        },
      });

      expect(rejected.status()).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: "invalid_scope" });
    }

    const started = await administrator.post("/api/auth/device/code", {
      form: {
        client_id: cliClientId,
        scope: "openid offline_access platform:read platform:write",
        resource: apiResource(environment.configuration),
      },
    });

    expect(started.status()).toBe(200);

    const device = z
      .object({ user_code: z.string(), device_code: z.string() })
      .parse(await started.json());

    expect(
      (await administrator.get(`/api/auth/device?user_code=${device.user_code}`)).status(),
    ).toBe(200);
    expect(
      (
        await administrator.post("/api/auth/device/approve", {
          data: { userCode: device.user_code },
        })
      ).status(),
    ).toBe(200);

    const exchange = await administrator.post("/api/auth/oauth2/token", {
      form: {
        client_id: cliClientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
      },
    });

    expect(exchange.status()).toBe(200);

    const tokens = z
      .object({
        access_token: z.string(),
        refresh_token: z.string(),
        expires_in: z.number().positive().max(300),
      })
      .parse(await exchange.json());

    const me = await fetch(`${origin}/api/v1/me`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });

    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: environment.owner.id });

    const refresh = await administrator.post("/api/auth/oauth2/token", {
      form: {
        client_id: cliClientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      },
    });

    expect(refresh.status()).toBe(200);
    const renewed = z.object({ refresh_token: z.string() }).parse(await refresh.json());
    expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
    expect(await resourceWrites()).toBe(0);
  });

  it("validates asset hashes, deduplicates R2 uploads, and queues deployments on the installation runtime", async () => {
    const created = await administrator.post("/api/v1/apps", {
      data: { slug: "cloudflare-upload", displayName: "Cloudflare Upload" },
    });

    expect(created.status()).toBe(200);
    const app = contract.app.parse(await created.json());
    const bytes = Buffer.from("Worker asset fixture");
    const hash = hashAsset("/index.html", bytes);
    const manifest = { "/index.html": { hash, size: bytes.byteLength } };

    const start = async () => {
      const response = await administrator.post(`/api/v1/apps/${app.id}/assets-upload-session`, {
        data: { manifest },
      });

      expect(response.status()).toBe(200);

      return contract.uploadSession.parse(await response.json());
    };

    const session = await start();
    expect(session.missing).toEqual([hash]);
    const path = `/api/v1/apps/${app.id}/assets/${session.id}/${hash}`;
    expect(
      (
        await administrator.put(path, {
          data: Buffer.from("invalid"),
          headers: { "content-type": "application/octet-stream" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await administrator.put(path, {
          data: bytes,
          headers: { "content-type": "application/octet-stream" },
        })
      ).status(),
    ).toBe(200);
    expect((await start()).missing).toEqual([]);
    const idempotencyKey = crypto.randomUUID();

    const publish = () =>
      administrator.put(`/api/v1/apps/${app.id}/worker`, {
        headers: { "idempotency-key": idempotencyKey },
        multipart: {
          metadata: JSON.stringify({
            main_module: "worker.js",
            compatibility_date: "2026-10-01",
            assets: { upload_session: session.id },
          }),
          "worker.js": {
            name: "worker.js",
            mimeType: "application/javascript+module",
            buffer: Buffer.from("export default { fetch() { return new Response('ok'); } };"),
          },
        },
      });

    const first = await publish();
    expect(first.status()).toBe(200);
    const deployment = contract.deployment.parse(await first.json());
    expect(deployment.status).toBe("queued");
    const retry = await publish();
    expect(retry.status()).toBe(200);
    expect(contract.deployment.parse(await retry.json()).id).toBe(deployment.id);
  }, 15_000);

  it("completes OIDC login, submits a management form, and signs out in a browser", async () => {
    const browser = await chromium.launch();

    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/sign-in`);
      await page.getByLabel("Email", { exact: true }).fill("sso@example.test");
      await page.getByRole("button", { name: "Continue with email", exact: true }).click();
      await page.getByRole("button", { name: /sso@example.test/ }).click();
      await browserExpect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
      await browserExpect(page.getByText("SSO Test User", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Manage", exact: true }).click();
      await page.getByRole("link", { name: "Create app", exact: true }).click();
      await page.getByLabel("App name", { exact: true }).fill("Worker Browser App");
      await page.getByLabel("URL slug").fill("worker-browser-app");
      await page.getByRole("button", { name: "Create app", exact: true }).click();
      await browserExpect(page.getByRole("heading", { level: 1 })).toHaveText("Worker Browser App");
      await page.reload();
      await browserExpect(page.getByRole("heading", { level: 1 })).toHaveText("Worker Browser App");
      await page.getByRole("button", { name: /^Account:/ }).click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await browserExpect(page).toHaveURL(/\/sign-in$/);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("serves health while installation and organization configuration reads are blocked", async () => {
    await environment.database.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`LOCK TABLE installation, organization_settings, sso_provider IN ACCESS EXCLUSIVE MODE`,
      );
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok" });
    });
  });

  it("rejects public setup while the installation has no owner", async () => {
    const database = environment.database.db;
    await database
      .update(installation)
      .set({ ownerId: null })
      .where(eq(installation.id, installationId));

    try {
      expect((await fetch(`${origin}/setup`)).status).toBe(503);

      const setup = await fetch(`${origin}/api/v1/setup`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Uninvited Owner",
          email: "uninvited@example.test",
        }),
      });

      expect(setup.status).toBe(403);
      expect((await readInstallation(database)).ownerId).toBeNull();
    } finally {
      await database
        .update(installation)
        .set({ ownerId: environment.owner.id })
        .where(eq(installation.id, installationId));
    }

    expect((await administrator.get("/api/v1/me")).status()).toBe(200);
  });
});
