import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { googleGroupsScope, organizationHttpAvailabilityKey } from "@platform/contracts";
import { authConfigurationKey } from "@platform/auth-proxy/publication";
import { mcpLoginKey, mcpOrganizationPrefix } from "@platform/auth-proxy/mcp-login";
import { createIdentityProvider } from "./edge/auth-proxy-idp.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const origin = "https://mcp.apps.example.test";

const token = "synthetic-management-token-at-least-32-characters";

const headers = { "content-type": "application/json" };

describe("MCP OAuth in the data plane", () => {
  let runtime: Miniflare;
  let idp: Awaited<ReturnType<typeof createIdentityProvider>>;
  const directoryRequests: string[] = [];
  let directoryGroups = ["accounting@example.test"];
  let directoryAvailable = true;
  const logs: string[] = [];
  const cookies = new Map<string, string>();

  const send = async (
    path: string,
    init: { method?: string; headers?: HeadersInit; body?: string } = {},
    withCookies = true,
  ) => {
    const requestHeaders = new Headers(init.headers);

    if (withCookies)
      requestHeaders.set(
        "cookie",
        [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      );

    const response = await runtime.dispatchFetch(new URL(path, origin).href, {
      ...init,
      headers: Object.fromEntries(requestHeaders),
      redirect: "manual",
    });

    if (withCookies)
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";")[0] ?? "";
        const offset = pair.indexOf("=");
        const name = pair.slice(0, offset);

        if (value.includes("Max-Age=0")) cookies.delete(name);
        else cookies.set(name, pair.slice(offset + 1));
      }

    return response;
  };

  const publish = async (
    organizationId = "company",
    domain = "example.test",
    scopes: string[] = [],
  ) => {
    const response = await send(`/fixture/organizations/${organizationId}/configuration`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        organizationId,
        organizationName: `Example ${organizationId}`,
        provider: { type: "google", domain },
        scopes,
        clientId: "customer-app",
        clientSecret: "customer-secret",
        cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
        domain: "apps.example.test",
        redirectUrl: `https://auth.apps.example.test/oauth2/${organizationId}/callback`,
      }),
    });

    expect(response.status).toBe(204);
  };

  beforeAll(async () => {
    idp = await createIdentityProvider([
      `${origin}/oauth/callback/google`,
      `${origin}/oauth/callback/company`,
      "https://auth.apps.example.test/oauth2/fallback/callback",
    ]);
    idp.settings.google = true;

    const compiled = await build({
      stdin: {
        contents: `
        import {mcpLoginRequest} from './src/mcp-login.ts';
        import {verifyMcpToken} from './src/mcp-authorization.ts';
        import {manageAuthConfiguration} from '@platform/auth-proxy/worker';
        export default {async fetch(request,env,ctx){
          const url=new URL(request.url);
          if(url.pathname.startsWith('/fixture/')) {
            if(url.pathname==='/fixture/form-limit') {
              let reads=0;
              let cancelled=false;
              const body=new ReadableStream({
                pull(controller) {
                  reads++;
                  if(reads>2) throw new Error('Read beyond the form limit');
                  controller.enqueue(new TextEncoder().encode('ü'.repeat(3000)));
                },
                cancel() {cancelled=true;}
              },{highWaterMark:0});
              const result=await mcpLoginRequest(new Request(new URL(url.searchParams.get('route'),url),{
                method:'POST',headers:{origin:url.origin,'content-type':'application/x-www-form-urlencoded'},body
              }),env,ctx);
              return Response.json({status:result.status,reads,cancelled});
            }
            if(url.pathname==='/fixture/identity') {
              try{return Response.json(await verifyMcpToken(env,request.headers.get('authorization')?.slice(7)??''));}
              catch{return new Response('Unauthorized',{status:401});}
            }
            url.pathname='/.well-known/widefleet/auth/'+url.pathname.slice('/fixture/'.length);
            return manageAuthConfiguration(new Request(url,request),env);
          }
          return await mcpLoginRequest(request,env,ctx) ?? new Response('Not found',{status:404});
        }};`,
        resolveDir: `${root}/packages/app-runtime`,
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      external: ["cloudflare:*", "node:*"],
    });

    runtime = new Miniflare({
      handleStructuredLogs: (log) => logs.push(JSON.stringify(log)),
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: "mcp",
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": {
                  type: "esm",
                  contents: z.string().parse(compiled.outputFiles[0]?.text),
                },
              },
            },
            env: {
              AUTH_CONFIG: { type: "kv", id: "auth" },
              WIDEFLEET_CONTROL_TOKEN: { type: "json", value: token },
              WIDEFLEET_MCP_ORIGIN: { type: "json", value: origin },
              WIDEFLEET_HTTP_AVAILABILITY: { type: "json", value: "kv" },
            },
          },
          dev: {
            outboundService: {
              type: "fetcher",
              handler: async (request) => {
                const url = new URL(request.url);

                if (url.origin === "https://cloudidentity.googleapis.com") {
                  directoryRequests.push(url.pathname);

                  if (!directoryAvailable) return new WorkerResponse(null, { status: 503 });

                  return WorkerResponse.json({
                    memberships: directoryGroups.map((id) => ({ groupKey: { id } })),
                  });
                }

                let path = url.pathname;

                if (url.origin === "https://oauth2.googleapis.com") path = "/token";

                if (url.origin === "https://www.googleapis.com") path = "/jwks";

                if (
                  ![
                    idp.origin,
                    "https://accounts.google.com",
                    "https://oauth2.googleapis.com",
                    "https://www.googleapis.com",
                  ].includes(url.origin)
                )
                  throw new Error(`Unexpected upstream ${url.origin}`);

                const options: RequestInit = {
                  method: request.method,
                  headers: Object.fromEntries(request.headers),
                  redirect: "manual",
                };

                if (request.method === "POST") options.body = await request.arrayBuffer();
                const result = await fetch(new URL(path, idp.origin), options);

                return new WorkerResponse(await result.arrayBuffer(), {
                  status: result.status,
                  headers: Object.fromEntries(result.headers),
                });
              },
            },
          },
        },
      ],
    });
    await runtime.ready;

    const configured = await send("/fixture/mcp/login", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        origin,
        platformUrl: "https://platform.example.test",
        google: { clientId: "app-login", clientSecret: "synthetic-client-secret" },
        microsoft: { clientId: "app-login", clientSecret: "synthetic-client-secret" },
      }),
    });

    expect(configured.status).toBe(204);
    await publish();
  });
  afterAll(async () => {
    await runtime?.dispose();
    await idp?.stop();
  });

  const authorize = async () => {
    const registered = await send("/oauth/register", {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_name: "Example client <script>bad()</script>",
        redirect_uris: ["https://client.example.test/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    expect(registered.status, await registered.clone().text()).toBe(201);
    const client = z.object({ client_id: z.string() }).parse(await registered.json());
    const verifier = crypto.randomUUID() + crypto.randomUUID();

    const parameters = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example.test/callback",
      response_type: "code",
      scope: "mcp:services",
      state: "client-state",
      resource: `${origin}/mcp`,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });

    const consent = await send(`/authorize?${parameters}`);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).not.toContain("<script>bad()");
    expect(html).toContain("client.example.test");
    const handle = z.string().parse(/name="handle" value="([^"]+)"/.exec(html)?.[1]);

    return { client: client.client_id, verifier, handle, url: `/authorize?${parameters}` };
  };

  const continueWith = (handle: string, provider = "google", withCookies = true) =>
    send(
      "/oauth/continue",
      {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle, provider }).toString(),
      },
      withCookies,
    );

  const login = async (target: string) => {
    const url = new URL(target);
    const authorized = await fetch(`${idp.origin}/authorize${url.search}`, { redirect: "manual" });
    expect(authorized.status, await authorized.clone().text()).toBe(302);

    return send(z.string().parse(authorized.headers.get("location")));
  };

  const exchange = async (callback: string, client: string, verifier: string) => {
    const url = new URL(callback);
    expect(url.origin).toBe("https://client.example.test");
    expect(url.searchParams.get("state")).toBe("client-state");

    return send("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client,
        redirect_uri: "https://client.example.test/callback",
        code_verifier: verifier,
        code: z.string().parse(url.searchParams.get("code")),
        resource: `${origin}/mcp`,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  };

  it("completes OAuth, refreshes, revokes and keeps all tokens scoped to the selected company without the control plane", async () => {
    const auth = await authorize();
    const signIn = await continueWith(auth.handle);
    expect(signIn.status, await signIn.clone().text()).toBe(303);
    const callback = await login(z.string().parse(signIn.headers.get("location")));
    expect(callback.status, await callback.clone().text()).toBe(303);

    const result = await exchange(
      z.string().parse(callback.headers.get("location")),
      auth.client,
      auth.verifier,
    );

    expect(result.status, await result.clone().text()).toBe(200);

    const grant = z
      .object({ access_token: z.string(), refresh_token: z.string() })
      .parse(await result.json());

    const claims = await send("/fixture/identity", {
      headers: { authorization: `Bearer ${grant.access_token}` },
    });

    expect(await claims.json()).toMatchObject({
      mcp: { organizationId: "company", identity: { subject: "pairwise-subject", groups: [] } },
    });
    expect(directoryRequests).toEqual([]);

    const refreshed = await send("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.client,
        refresh_token: grant.refresh_token,
        resource: `${origin}/mcp`,
      }).toString(),
    });

    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = z.object({ access_token: z.string() }).parse(await refreshed.json());

    const metadata = z
      .object({ revocation_endpoint: z.string() })
      .parse(await (await send("/.well-known/oauth-authorization-server")).json());

    const revoked = await send(metadata.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: next.access_token, client_id: auth.client }).toString(),
    });

    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(
      (
        await send("/fixture/identity", {
          headers: { authorization: `Bearer ${next.access_token}` },
        })
      ).status,
    ).toBe(401);

    const repeated = await exchange(
      z.string().parse(callback.headers.get("location")),
      auth.client,
      auth.verifier,
    );

    expect(repeated.status).toBe(400);
  });

  it("rejects consent from a different browser and keeps the redirect bound to the registered client", async () => {
    const auth = await authorize();
    expect((await continueWith(auth.handle, "google", false)).status).toBe(400);

    const bad = await send(
      `/authorize?client_id=${auth.client}&redirect_uri=https://attacker.example.test&response_type=code`,
    );

    expect(bad.headers.get("location")).toBeNull();
    expect(bad.status).toBe(400);
  });

  it("uses the normal Widefleet sign-in when there is no company SSO context", async () => {
    idp.settings.google = false;

    const published = await send("/fixture/organizations/fallback/configuration", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        organizationId: "fallback",
        provider: { type: "oidc", issuer: idp.origin, label: "Widefleet" },
        clientId: "app-login",
        clientSecret: "synthetic-client-secret",
        cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
        domain: "apps.example.test",
        redirectUrl: "https://auth.apps.example.test/oauth2/fallback/callback",
      }),
    });

    expect(published.status).toBe(204);
    const auth = await authorize();
    const response = await continueWith(auth.handle, "widefleet");
    const target = new URL(z.string().parse(response.headers.get("location")));
    expect(target.origin + target.pathname).toBe("https://platform.example.test/mcp/sign-in");
    expect(target.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The control plane supplies organization context after its normal sign-in.
    // That context alone must not issue a token: the existing app OAuth flow
    // still verifies an identity before returning through the auth-host bridge.
    const resumed = await send(
      `/oauth/organization?${new URLSearchParams({
        state: z.string().parse(target.searchParams.get("state")),
        organization: "fallback",
      })}`,
    );

    expect(resumed.status, await resumed.clone().text()).toBe(303);
    const upstream = new URL(z.string().parse(resumed.headers.get("location")));
    expect(upstream.origin).toBe(idp.origin);
    expect(upstream.searchParams.get("redirect_uri")).toBe(
      "https://auth.apps.example.test/oauth2/fallback/callback",
    );
    const bridge = await login(upstream.href);
    expect(bridge.status, await bridge.clone().text()).toBe(303);
    const callback = await send(z.string().parse(bridge.headers.get("location")));
    expect(callback.status, await callback.clone().text()).toBe(303);

    const responseToken = await exchange(
      z.string().parse(callback.headers.get("location")),
      auth.client,
      auth.verifier,
    );

    expect(responseToken.status, await responseToken.clone().text()).toBe(200);
    const grant = z.object({ access_token: z.string() }).parse(await responseToken.json());

    const identity = await send("/fixture/identity", {
      headers: { authorization: `Bearer ${grant.access_token}` },
    });

    expect(await identity.json()).toMatchObject({
      mcp: { organizationId: "fallback", identity: { subject: "pairwise-subject" } },
    });
    idp.settings.google = true;
  });

  it("requests directory access only after discovering an organization that uses Google groups", async () => {
    directoryGroups = Array.from({ length: 205 }, (_, index) => `group${index}@example.test`);
    await publish("company", "example.test", [googleGroupsScope]);
    const auth = await authorize();
    const start = await continueWith(auth.handle);
    const extra = await login(z.string().parse(start.headers.get("location")));
    expect(extra.status, await extra.clone().text()).toBe(303);
    const provider = new URL(z.string().parse(extra.headers.get("location")));
    expect(provider.searchParams.get("scope")).toContain(googleGroupsScope);
    expect(provider.searchParams.get("hd")).toBe("example.test");
    idp.settings.grantedScopes = `openid email profile ${googleGroupsScope}`;
    const callback = await login(provider.href);
    expect(callback.status, await callback.clone().text()).toBe(303);

    const response = await exchange(
      z.string().parse(callback.headers.get("location")),
      auth.client,
      auth.verifier,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const grant = z.object({ access_token: z.string() }).parse(await response.json());

    const identity = await send("/fixture/identity", {
      headers: { authorization: `Bearer ${grant.access_token}` },
    });

    expect(await identity.json()).toMatchObject({
      mcp: { identity: { groups: directoryGroups } },
    });
    expect(directoryRequests).toHaveLength(1);
    idp.settings.grantedScopes = "";
    directoryGroups = ["accounting@example.test"];
    await publish();
    expect(
      (
        await send("/fixture/identity", {
          headers: { authorization: `Bearer ${grant.access_token}` },
        })
      ).status,
    ).toBe(401);
  });

  it("retains a rotated provider credential after directory failure without issuing or extending access", async () => {
    await publish("company", "example.test", [googleGroupsScope]);
    idp.settings.grantedScopes = `openid email profile ${googleGroupsScope}`;
    idp.settings.rotateRefreshTokens = true;
    idp.settings.refreshReplaySeconds = 0;

    try {
      const auth = await authorize();
      const signIn = await continueWith(auth.handle);
      const callback = await login(z.string().parse(signIn.headers.get("location")));

      const response = await exchange(
        z.string().parse(callback.headers.get("location")),
        auth.client,
        auth.verifier,
      );

      expect(response.status, await response.clone().text()).toBe(200);

      const grant = z
        .object({ access_token: z.string(), refresh_token: z.string() })
        .parse(await response.json());

      const storage = await runtime.getKVNamespace("AUTH_CONFIG");
      const key = `grant:${grant.refresh_token.split(":").slice(0, 2).join(":")}`;
      const stored = z.object({ expiresAt: z.number(), encryptedProps: z.string() });
      const before = stored.parse(await storage.get(key, "json"));
      const tokens = await storage.list({ prefix: "token:" });

      const refresh = (token = grant.refresh_token) =>
        send("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: auth.client,
            refresh_token: token,
            resource: `${origin}/mcp`,
          }).toString(),
        });

      directoryAvailable = false;
      const failed = await refresh();
      expect(failed.status, await failed.clone().text()).toBe(503);
      expect(await failed.json()).toEqual({
        error: "temporarily_unavailable",
        error_description: "Company sign-in could not be refreshed",
      });
      const consumed = idp.refreshRequests.at(-1);
      const after = stored.parse(await storage.get(key, "json"));
      expect(after.expiresAt).toBe(before.expiresAt);
      expect(after.encryptedProps).not.toBe(before.encryptedProps);
      expect(await storage.list({ prefix: "token:" })).toEqual(tokens);

      directoryAvailable = true;
      directoryGroups = ["changed@example.test"];
      const retry = await refresh();
      expect(retry.status, await retry.clone().text()).toBe(200);
      expect(idp.refreshRequests.at(-1)).not.toBe(consumed);

      const next = z
        .object({ access_token: z.string(), refresh_token: z.string() })
        .parse(await retry.json());

      expect(
        await (
          await send("/fixture/identity", {
            headers: { authorization: `Bearer ${next.access_token}` },
          })
        ).json(),
      ).toMatchObject({ mcp: { identity: { groups: directoryGroups } } });
      // A late retry may present the previous downstream token. Its rotated
      // upstream credential must also remain decryptable after an error.
      directoryAvailable = false;
      expect((await refresh()).status).toBe(503);
      directoryAvailable = true;
      expect((await refresh()).status).toBe(200);
    } finally {
      directoryAvailable = true;
      directoryGroups = ["accounting@example.test"];
      idp.settings.rotateRefreshTokens = false;
      idp.settings.refreshReplaySeconds = 30;
      idp.settings.grantedScopes = "";
      await publish();
    }
  });

  it.each(["/oauth/continue", "/oauth/select"])(
    "stops reading oversized %s forms at the byte limit",
    async (route) => {
      const response = await send(`/fixture/form-limit?${new URLSearchParams({ route })}`);
      expect(await response.json()).toEqual({ status: 400, reads: 2, cancelled: true });
    },
  );

  it("logs unavailable login configuration while returning a safe error page", async () => {
    const auth = await authorize();
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");
    const saved = z.string().parse(await storage.get(mcpLoginKey));
    await storage.delete(mcpLoginKey);
    const first = logs.length;

    try {
      const response = await send(auth.url);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("MCP sign-in is not configured");
      await expect
        .poll(() => logs.slice(first).join("\n"))
        .toContain("MCP sign-in is not configured");
      expect(logs.slice(first).join("\n")).not.toContain(auth.handle);
    } finally {
      await storage.put(mcpLoginKey, saved);
    }
  });

  it("shows only organizations matching the verified account and binds the choice to the browser", async () => {
    await publish("second");
    await publish("other-company", "other.example.test");
    const auth = await authorize();
    const start = await continueWith(auth.handle);
    const selection = await login(z.string().parse(start.headers.get("location")));
    expect(selection.status, await selection.clone().text()).toBe(200);
    const html = await selection.text();
    expect(html).toContain("Example company");
    expect(html).toContain("Example second");
    expect(html).not.toContain("Example other-company");
    const state = z.string().parse(/name="state" value="([^"]+)"/.exec(html)?.[1]);

    const chosen = await send("/oauth/select", {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state, organization: "second" }).toString(),
    });

    expect(chosen.status, await chosen.clone().text()).toBe(303);

    const response = await exchange(
      z.string().parse(chosen.headers.get("location")),
      auth.client,
      auth.verifier,
    );

    const grant = z.object({ access_token: z.string() }).parse(await response.json());

    const identity = await send("/fixture/identity", {
      headers: { authorization: `Bearer ${grant.access_token}` },
    });

    expect(await identity.json()).toMatchObject({ mcp: { organizationId: "second" } });

    const replay = await send("/oauth/select", {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state, organization: "company" }).toString(),
    });

    expect(replay.status).toBe(400);
    await publish("second", "elsewhere.example.test");
  });

  it("rejects a different Workspace even when its verified email has a familiar suffix", async () => {
    idp.settings.workspaceDomain = "unconfigured.example.test";
    const auth = await authorize();
    const start = await continueWith(auth.handle);
    const callback = await login(z.string().parse(start.headers.get("location")));
    expect(callback.status).toBe(400);
    expect(callback.headers.get("location")).toBeNull();
    idp.settings.workspaceDomain = "example.test";
  });

  it("keeps active company sign-in usable when the tenant index contains suspended or deleted organizations", async () => {
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");
    await publish("suspended");
    await storage.put(
      organizationHttpAvailabilityKey("suspended"),
      JSON.stringify({ blocked: true }),
    );
    await publish("deleted");
    await storage.delete(authConfigurationKey("deleted"));
    await storage.put(`${mcpOrganizationPrefix("google", "example.test")}second`, "second");

    try {
      const auth = await authorize();
      const start = await continueWith(auth.handle);
      const callback = await login(z.string().parse(start.headers.get("location")));
      expect(callback.status, await callback.clone().text()).toBe(303);

      const response = await exchange(
        z.string().parse(callback.headers.get("location")),
        auth.client,
        auth.verifier,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      const grant = z.object({ access_token: z.string() }).parse(await response.json());

      const identity = await send("/fixture/identity", {
        headers: { authorization: `Bearer ${grant.access_token}` },
      });

      expect(await identity.json()).toMatchObject({ mcp: { organizationId: "company" } });

      await storage.put(
        organizationHttpAvailabilityKey("company"),
        JSON.stringify({ blocked: true }),
      );
      expect(
        (
          await send("/fixture/identity", {
            headers: { authorization: `Bearer ${grant.access_token}` },
          })
        ).status,
      ).toBe(401);
    } finally {
      await storage.delete(organizationHttpAvailabilityKey("company"));

      for (const id of ["suspended", "deleted", "second"])
        await storage.delete(`${mcpOrganizationPrefix("google", "example.test")}${id}`);
    }
  });

  it("does not rewrite shared login credentials when another organization publishes the same registration", async () => {
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");
    const original = await storage.get(mcpLoginKey);

    const configuration = {
      origin,
      platformUrl: "https://platform.example.test",
      google: { clientId: "app-login", clientSecret: "synthetic-client-secret" },
      microsoft: { clientId: "app-login", clientSecret: "synthetic-client-secret" },
    };

    const repeated = await send("/fixture/mcp/login", {
      method: "PUT",
      headers,
      body: JSON.stringify(configuration),
    });

    expect(repeated.status).toBe(204);
    expect(await storage.get(mcpLoginKey)).toBe(original);

    const changed = await send("/fixture/mcp/login", {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...configuration, platformUrl: "https://new-platform.example.test" }),
    });

    expect(changed.status).toBe(204);
    expect(await storage.get(mcpLoginKey)).not.toBe(original);
  });
});
