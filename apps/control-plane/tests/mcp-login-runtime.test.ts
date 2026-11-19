import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { googleGroupsScope, organizationHttpAvailabilityKey } from "@platform/contracts";
import { authConfigurationKey } from "@platform/auth-proxy/publication";
import { mcpDomainPrefix, mcpLoginKey } from "@platform/auth-proxy/mcp-login";
import { createIdentityProvider, tenantId } from "./edge/auth-proxy-idp.ts";

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
  let controlPlaneAvailable = true;
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
        clientId: "app-login",
        clientSecret: "synthetic-client-secret",
        cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
        domain: "apps.example.test",
        redirectUrl: `https://auth.apps.example.test/oauth2/${organizationId}/callback`,
        emailDomains: [domain],
      }),
    });

    expect(response.status).toBe(204);
  };

  beforeAll(async () => {
    idp = await createIdentityProvider(
      ["company", "second", "entra", "fallback"].map(
        (organizationId) => `https://auth.apps.example.test/oauth2/${organizationId}/callback`,
      ),
    );
    idp.settings.google = true;

    const compiled = await build({
      stdin: {
        contents: `
        import {mcpLoginRequest} from './src/mcp-login.ts';
        import {verifyMcpToken} from './src/mcp-authorization.ts';
        import {manageAuthConfiguration} from '@platform/auth-proxy/worker';
        import {mcpOAuthStorage} from './src/mcp-grants.ts';
        import {McpGrants} from './src/mcp-grants.ts';
        // Recreates an owner without the grant store, as before it existed.
        export class TestGrants extends McpGrants {
          async reset(){await this.ctx.storage.deleteAll();}
          // Ends the migration window now instead of after five minutes.
          // KV deletes of the given key fail, as during a KV outage.
          async finishMigration(failing){
            const migration=await this.ctx.storage.get('migration');
            if(migration) await this.ctx.storage.put('migration',{...migration,deleteAt:Date.now()});
            const env=this.env;
            const kv=env.AUTH_CONFIG;
            this.env={...env,AUTH_CONFIG:{...kv,list:kv.list.bind(kv),get:kv.get.bind(kv),delete:(name)=>name===failing?Promise.reject(new Error('KV unavailable')):kv.delete(name)}};
            try {await this.alarm();} finally {this.env=env;}
          }
        }
        export default {async fetch(request,env,ctx){
          const url=new URL(request.url);
          if(url.pathname.startsWith('/fixture/')) {
            if(url.pathname==='/fixture/grants/reset' || url.pathname==='/fixture/grants/finish') {
              const object=env.WIDEFLEET_MCP_GRANTS.get(env.WIDEFLEET_MCP_GRANTS.idFromName(url.searchParams.get('owner')));
              try {await (url.pathname.endsWith('/reset') ? object.reset() : object.finishMigration(url.searchParams.get('failing')));}
              catch {return new Response(null,{status:503});}
              return new Response(null,{status:204});
            }
            if(url.pathname==='/fixture/grants') {
              const storage=mcpOAuthStorage(env);
              const prefix=url.searchParams.get('prefix');
              if(request.method==='DELETE') {
                await storage.delete(url.searchParams.get('key'));
                return new Response(null,{status:204});
              }
              if(request.method==='PUT') {
                await storage.put(url.searchParams.get('key'),await request.text(),{expiration:Number(url.searchParams.get('expiration'))});
                return new Response(null,{status:204});
              }
              const {keys}=await storage.list({prefix});
              return Response.json(await Promise.all(keys.map(async (key)=>({...key,value:await storage.get(key.name)}))));
            }
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
      conditions: ["workerd"],
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
            exports: { TestGrants: { type: "durable-object", storage: "sqlite" } },
            env: {
              AUTH_CONFIG: { type: "kv", id: "auth" },
              WIDEFLEET_MCP_GRANTS: {
                type: "durable-object",
                worker: "mcp",
                exportName: "TestGrants",
              },
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

                if (url.origin === "https://platform.example.test" && url.pathname === "/healthz")
                  return new WorkerResponse(null, { status: controlPlaneAvailable ? 200 : 503 });

                // Microsoft's public discovery resolves any domain of the fixture tenant.
                if (
                  url.origin === "https://login.microsoftonline.com" &&
                  /^\/[a-z.-]+\/v2\.0\/\.well-known\/openid-configuration$/.test(url.pathname)
                )
                  return url.pathname.startsWith("/tenant-alias.example.test/")
                    ? WorkerResponse.json({
                        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
                      })
                    : WorkerResponse.json({ error: "invalid_tenant" }, { status: 400 });

                let path = url.pathname;

                if (url.origin === "https://oauth2.googleapis.com") path = "/token";

                if (url.origin === "https://www.googleapis.com") path = "/jwks";

                if (
                  ![
                    idp.origin,
                    "https://accounts.google.com",
                    "https://login.microsoftonline.com",
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
      }),
    });

    expect(configured.status).toBe(204);
    await publish();
  });
  afterAll(async () => {
    await runtime?.dispose();
    await idp?.stop();
  });

  const register = async () => {
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

    return z.object({ client_id: z.string() }).parse(await registered.json());
  };

  const authorize = async (client?: { client_id: string }) => {
    client ??= await register();
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

  const continueWith = (
    handle: string,
    provider: string,
    fields: Record<string, string> = {},
    withCookies = true,
  ) =>
    send(
      "/oauth/continue",
      {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle, provider, ...fields }).toString(),
      },
      withCookies,
    );

  const continueWithEmail = (handle: string, email = "person@example.test") =>
    continueWith(handle, "email", { email, authorize: "/authorize?client_id=retry" });

  const login = async (target: string) => {
    const url = new URL(target);
    const authorized = await fetch(`${idp.origin}/authorize${url.search}`, { redirect: "manual" });
    expect(authorized.status, await authorized.clone().text()).toBe(302);

    return send(z.string().parse(authorized.headers.get("location")));
  };

  // Company sign-in returns through the auth host, which bridges to the MCP origin.
  const companyLogin = async (target: string) => {
    const bridge = await login(target);
    expect(bridge.status, await bridge.clone().text()).toBe(303);

    return send(z.string().parse(bridge.headers.get("location")));
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

  const refreshWith = (client: string, token: string) =>
    send("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client,
        refresh_token: token,
        resource: `${origin}/mcp`,
      }).toString(),
    });

  const grantOwner = (token: string) => z.string().parse(token.split(":")[0]);

  const grantKey = (token: string) => `grant:${token.split(":").slice(0, 2).join(":")}`;

  // Grants live in the Durable Object store, read here through the same adapter.
  const storedGrants = async (owner: string) => {
    const response = await send(`/fixture/grants?prefix=${encodeURIComponent(`grant:${owner}:`)}`);
    expect(response.status, await response.clone().text()).toBe(200);

    return z
      .array(
        z.object({
          name: z.string(),
          value: z.string(),
          expiration: z.number().optional(),
          metadata: z.json().optional(),
        }),
      )
      .parse(await response.json());
  };

  const storedGrant = async (token: string) =>
    z
      .string()
      .parse(
        (await storedGrants(grantOwner(token))).find(({ name }) => name === grantKey(token))?.value,
      );

  const connect = async (client?: { client_id: string }) => {
    const auth = await authorize(client);
    const signIn = await continueWithEmail(auth.handle);
    const callback = await companyLogin(z.string().parse(signIn.headers.get("location")));

    const response = await exchange(
      z.string().parse(callback.headers.get("location")),
      auth.client,
      auth.verifier,
    );

    expect(response.status, await response.clone().text()).toBe(200);

    return {
      client: auth.client,
      ...z
        .object({ access_token: z.string(), refresh_token: z.string() })
        .parse(await response.json()),
    };
  };

  it("finds the company from a work email, remembers it and keeps tokens scoped without the control plane", async () => {
    controlPlaneAvailable = false;

    try {
      const auth = await authorize();
      expect(await (await send(auth.url)).text()).not.toContain("Connected before");
      const signIn = await continueWithEmail(auth.handle);
      expect(signIn.status, await signIn.clone().text()).toBe(303);

      // The organization's own registration signs the person in, with the email as hint.
      const upstream = new URL(z.string().parse(signIn.headers.get("location")));
      expect(upstream.searchParams.get("client_id")).toBe("app-login");
      expect(upstream.searchParams.get("login_hint")).toBe("person@example.test");
      expect(upstream.searchParams.get("redirect_uri")).toBe(
        "https://auth.apps.example.test/oauth2/company/callback",
      );

      const callback = await companyLogin(upstream.href);
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

      // The browser remembers the organization for the next client it connects.
      const next = await authorize();
      const offered = await (await send(next.url)).text();
      expect(offered).toContain("Example company");
      expect(offered).toContain("Connected before");
      const remembered = await continueWith(next.handle, "organization:company");
      expect(remembered.status, await remembered.clone().text()).toBe(303);
      expect(new URL(z.string().parse(remembered.headers.get("location"))).origin).toBe(idp.origin);

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
      const renewed = z.object({ access_token: z.string() }).parse(await refreshed.json());

      const metadata = z
        .object({ revocation_endpoint: z.string() })
        .parse(await (await send("/.well-known/oauth-authorization-server")).json());

      const revoked = await send(metadata.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: renewed.access_token,
          client_id: auth.client,
        }).toString(),
      });

      expect(revoked.status, await revoked.clone().text()).toBe(200);
      expect(
        (
          await send("/fixture/identity", {
            headers: { authorization: `Bearer ${renewed.access_token}` },
          })
        ).status,
      ).toBe(401);

      const repeated = await exchange(
        z.string().parse(callback.headers.get("location")),
        auth.client,
        auth.verifier,
      );

      expect(repeated.status).toBe(400);
    } finally {
      controlPlaneAvailable = true;
    }
  });

  it("ignores remembered organizations whose cookie was altered", async () => {
    const name = [...cookies.keys()].find((key) => key === "__Host-widefleet-mcp-organizations");
    const saved = name ? cookies.get(name) : undefined;

    if (!name || !saved) throw new Error("Expected a remembered organization");

    try {
      const [, signature] = saved.split(".");
      const forged = Buffer.from(JSON.stringify(["second"])).toString("base64url");
      cookies.set(name, `${forged}.${signature}`);
      const auth = await authorize();
      expect(await (await send(auth.url)).text()).not.toContain("Connected before");
      expect((await continueWith(auth.handle, "organization:second")).status).toBe(400);
    } finally {
      cookies.set(name, saved);
    }
  });

  it("finds an Entra organization from any domain of its tenant", async () => {
    const published = await send("/fixture/organizations/entra/configuration", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        organizationId: "entra",
        organizationName: "Example Entra",
        provider: {
          type: "entra",
          authority: "https://login.microsoftonline.com",
          tenantId,
          label: "Microsoft Entra",
        },
        clientId: "app-login",
        clientSecret: "synthetic-client-secret",
        cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
        domain: "apps.example.test",
        redirectUrl: "https://auth.apps.example.test/oauth2/entra/callback",
      }),
    });

    expect(published.status).toBe(204);
    idp.settings.entra = true;
    idp.settings.entraAuthority = "https://login.microsoftonline.com";

    try {
      const auth = await authorize();
      const signIn = await continueWithEmail(auth.handle, "person@tenant-alias.example.test");
      expect(signIn.status, await signIn.clone().text()).toBe(303);
      const upstream = new URL(z.string().parse(signIn.headers.get("location")));
      expect(upstream.searchParams.get("login_hint")).toBe("person@tenant-alias.example.test");
      expect(upstream.searchParams.get("redirect_uri")).toBe(
        "https://auth.apps.example.test/oauth2/entra/callback",
      );
    } finally {
      idp.settings.entra = false;
      idp.settings.entraAuthority = "";
      await send("/fixture/organizations/entra/configuration", { method: "DELETE" });
    }
  });

  it("falls back to Widefleet sign-in for unknown or shared domains and explains an outage", async () => {
    const platform = (response: { headers: { get(name: string): string | null } }) => {
      const target = new URL(z.string().parse(response.headers.get("location")));
      expect(target.origin + target.pathname).toBe("https://platform.example.test/mcp/sign-in");

      return z.string().parse(target.searchParams.get("state"));
    };

    // The control plane returns the chosen organization; the entered email still hints the account.
    const hinted = async (state: string) => {
      const resumed = await send(
        `/oauth/organization?${new URLSearchParams({ state, organization: "company" })}`,
      );

      expect(resumed.status, await resumed.clone().text()).toBe(303);

      return new URL(z.string().parse(resumed.headers.get("location"))).searchParams.get(
        "login_hint",
      );
    };

    // A guest's own company domain names no organization here.
    const unknown = await authorize();

    expect(
      await hinted(
        platform(await continueWithEmail(unknown.handle, "guest@consultancy.example.test")),
      ),
    ).toBe("guest@consultancy.example.test");

    // A domain proven by several organizations needs the person's memberships.
    await publish("second");

    try {
      const shared = await authorize();
      platform(await continueWithEmail(shared.handle));
    } finally {
      await publish("second", "second.example.test");
    }

    controlPlaneAvailable = false;

    try {
      const auth = await authorize();
      const unavailable = await continueWithEmail(auth.handle, "guest@consultancy.example.test");
      expect(unavailable.status).toBe(200);
      const html = await unavailable.text();
      expect(html).toContain("Widefleet sign-in is unavailable");
      expect(html).toContain('href="/authorize?client_id=retry"');
      expect(html).toContain('name="email" value="guest@consultancy.example.test"');

      // The consent is still open, so the person can retry or try anyway.
      const retried = await continueWith(auth.handle, "widefleet", {
        confirmed: "1",
        authorize: "/authorize?client_id=retry",
        email: "guest@consultancy.example.test",
      });

      expect(await hinted(platform(retried))).toBe("guest@consultancy.example.test");
    } finally {
      controlPlaneAvailable = true;
    }
  });

  it("rejects consent from a different browser and keeps the redirect bound to the registered client", async () => {
    const auth = await authorize();
    expect(
      (await continueWith(auth.handle, "email", { email: "person@example.test" }, false)).status,
    ).toBe(400);

    const bad = await send(
      `/authorize?client_id=${auth.client}&redirect_uri=https://attacker.example.test&response_type=code`,
    );

    expect(bad.headers.get("location")).toBeNull();
    expect(bad.status).toBe(400);
  });

  it.each([false, true])("refreshes generic OIDC (Google issuer: %s)", async (google) => {
    idp.settings.google = google;

    const published = await send("/fixture/organizations/fallback/configuration", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        organizationId: "fallback",
        provider: {
          type: "oidc",
          issuer: google ? "https://accounts.google.com" : idp.origin,
          label: "Company",
          groupsClaim: "roles",
        },
        scopes: ["openid", "profile", "email", "offline_access"],
        clientId: "app-login",
        clientSecret: "synthetic-client-secret",
        cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
        domain: "apps.example.test",
        redirectUrl: "https://auth.apps.example.test/oauth2/fallback/callback",
      }),
    });

    expect(published.status).toBe(204);
    const auth = await authorize();

    const response = await continueWith(auth.handle, "widefleet", {
      authorize: "/authorize?client_id=retry",
    });

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
    expect(upstream.searchParams.get("scope")?.includes("offline_access")).toBe(!google);

    if (google) {
      expect(upstream.searchParams.get("access_type")).toBe("offline");
      expect(upstream.searchParams.get("prompt")).toBe("consent");
      expect(upstream.searchParams.has("hd")).toBe(false);
    }

    const callback = await companyLogin(upstream.href);
    expect(callback.status, await callback.clone().text()).toBe(303);

    const responseToken = await exchange(
      z.string().parse(callback.headers.get("location")),
      auth.client,
      auth.verifier,
    );

    expect(responseToken.status, await responseToken.clone().text()).toBe(200);

    const grant = z
      .object({ access_token: z.string(), refresh_token: z.string() })
      .parse(await responseToken.json());

    const identity = await send("/fixture/identity", {
      headers: { authorization: `Bearer ${grant.access_token}` },
    });

    expect(await identity.json()).toMatchObject({
      mcp: {
        organizationId: "fallback",
        identity: { subject: "pairwise-subject", groups: ["accounting"] },
      },
    });

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

    const renewed = z
      .object({ access_token: z.string(), refresh_token: z.string() })
      .parse(await refreshed.json());

    expect(
      (
        await send("/fixture/identity", {
          headers: { authorization: `Bearer ${renewed.access_token}` },
        })
      ).status,
    ).toBe(200);
    idp.settings.google = true;
  });

  it("requests Google group access through the organization's registration", async () => {
    directoryGroups = Array.from({ length: 205 }, (_, index) => `group${index}@example.test`);
    await publish("company", "example.test", [googleGroupsScope]);
    const auth = await authorize();
    const start = await continueWithEmail(auth.handle);
    const provider = new URL(z.string().parse(start.headers.get("location")));
    expect(provider.searchParams.get("client_id")).toBe("app-login");
    expect(provider.searchParams.get("scope")).toContain(googleGroupsScope);
    expect(provider.searchParams.get("hd")).toBe("example.test");
    idp.settings.grantedScopes = `openid email profile ${googleGroupsScope}`;
    const callback = await companyLogin(provider.href);
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
      const signIn = await continueWithEmail(auth.handle);
      const callback = await companyLogin(z.string().parse(signIn.headers.get("location")));

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
      const stored = z.object({ expiresAt: z.number(), encryptedProps: z.string() });
      const before = stored.parse(JSON.parse(await storedGrant(grant.refresh_token)));
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
      const after = stored.parse(JSON.parse(await storedGrant(grant.refresh_token)));
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
      // The token issued by the successful refresh must survive the late retry.
      const latest = await refresh(next.refresh_token);
      expect(latest.status, await latest.clone().text()).toBe(200);
    } finally {
      directoryAvailable = true;
      directoryGroups = ["accounting@example.test"];
      idp.settings.rotateRefreshTokens = false;
      idp.settings.refreshReplaySeconds = 30;
      idp.settings.grantedScopes = "";
      await publish();
    }
  });

  it("keeps grants out of KV and rotates refresh tokens against the latest grant", async () => {
    const connection = await connect();
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");
    expect((await storage.list({ prefix: "grant:" })).keys).toEqual([]);
    let token = connection.refresh_token;

    for (let refresh = 0; refresh < 3; refresh++) {
      const response = await refreshWith(connection.client, token);
      expect(response.status, await response.clone().text()).toBe(200);
      token = z.object({ refresh_token: z.string() }).parse(await response.json()).refresh_token;
    }

    // A refresh token from three rotations ago is no longer accepted.
    expect((await refreshWith(connection.client, connection.refresh_token)).status).toBe(400);
    expect((await refreshWith(connection.client, token)).status).toBe(200);
    expect((await storage.list({ prefix: "grant:" })).keys).toEqual([]);
  });

  // Recreates the layout before the grant store: the owner's grants exist only in KV.
  const storeInKv = async (owner: string, grants: Awaited<ReturnType<typeof storedGrants>>) => {
    const reset = await send(`/fixture/grants/reset?owner=${encodeURIComponent(owner)}`, {
      method: "POST",
    });

    expect(reset.status).toBe(204);
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");

    for (const { name, value, expiration, metadata } of grants)
      await storage.put(name, value, { expiration: z.number().parse(expiration), metadata });
  };

  it("moves grants created before the grant store out of KV on first use", async () => {
    const connection = await connect();
    const owner = grantOwner(connection.refresh_token);
    const grants = await storedGrants(owner);
    const grant = grants.find(({ name }) => name === grantKey(connection.refresh_token));
    expect(grant?.metadata).toMatchObject({ clientId: connection.client });
    const unrelated = `grant:${owner}:unrelated`;

    await storeInKv(owner, [
      ...grants,
      { name: unrelated, value: "{}", expiration: Math.floor(Date.now() / 1000) + 600 },
    ]);

    const finish = (failing = "") =>
      send(
        `/fixture/grants/finish?owner=${encodeURIComponent(owner)}&failing=${encodeURIComponent(failing)}`,
        { method: "POST" },
      );

    // KV keeps its copies until the migration window ends.
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");
    expect((await storedGrants(owner)).map(({ name }) => name)).toContain(unrelated);
    expect(await storage.get(grantKey(connection.refresh_token))).not.toBeNull();

    // A partly failed cleanup must not turn deleted KV copies into revocations.
    expect((await finish(unrelated)).status).toBe(503);
    expect(await storage.get(grantKey(connection.refresh_token))).toBeNull();
    expect(await storage.get(unrelated)).not.toBeNull();
    const response = await refreshWith(connection.client, connection.refresh_token);
    expect(response.status, await response.clone().text()).toBe(200);

    expect((await finish()).status).toBe(204);
    expect((await storage.list({ prefix: `grant:${owner}:` })).keys).toEqual([]);

    const { refresh_token: token } = z
      .object({ refresh_token: z.string() })
      .parse(await response.json());

    expect((await refreshWith(connection.client, token)).status).toBe(200);
  });

  it("replaces a stale imported grant with the newer KV record", async () => {
    const connection = await connect();
    const owner = grantOwner(connection.refresh_token);
    const stale = await storedGrants(owner);
    const refreshed = await refreshWith(connection.client, connection.refresh_token);
    expect(refreshed.status).toBe(200);

    const { refresh_token: token } = z
      .object({ refresh_token: z.string() })
      .parse(await refreshed.json());

    const current = await storedGrants(owner);

    // The first import reads the record from before the refresh, as from a stale
    // KV location cache. KV then returns the current record.
    await storeInKv(owner, stale);
    expect(await storedGrants(owner)).toEqual(stale);
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");

    for (const { name, value, expiration, metadata } of current)
      await storage.put(name, value, { expiration: z.number().parse(expiration), metadata });

    const response = await refreshWith(connection.client, token);
    expect(response.status, await response.clone().text()).toBe(200);

    // A grant revoked after the import is not imported again from its KV copy.
    await send(`/fixture/grants?key=${encodeURIComponent(grantKey(token))}`, {
      method: "DELETE",
    });

    expect(await storage.get(grantKey(token))).not.toBeNull();
    expect((await refreshWith(connection.client, token)).status).toBe(400);
  });

  it("does not return expired grants", async () => {
    const owner = "expiring-owner";
    const seconds = Math.floor(Date.now() / 1000);

    for (const [grant, expiration] of [
      ["expired", seconds - 1],
      ["current", seconds + 600],
    ] as const) {
      const response = await send(
        `/fixture/grants?key=grant:${owner}:${grant}&expiration=${expiration}`,
        { method: "PUT", body: "{}" },
      );

      expect(response.status).toBe(204);
    }

    expect((await storedGrants(owner)).map(({ name }) => name)).toEqual([`grant:${owner}:current`]);
  });

  it("replaces a client's earlier grant when the person connects it again", async () => {
    const first = await connect();
    const second = await connect({ client_id: first.client });
    expect(grantOwner(second.refresh_token)).toBe(grantOwner(first.refresh_token));

    expect((await refreshWith(first.client, first.refresh_token)).status).toBe(400);
    expect((await refreshWith(second.client, second.refresh_token)).status).toBe(200);
    expect(
      (await storedGrants(grantOwner(second.refresh_token))).map((stored) => stored.name),
    ).toContain(grantKey(second.refresh_token));
    expect(
      (await storedGrants(grantOwner(first.refresh_token))).map((stored) => stored.name),
    ).not.toContain(grantKey(first.refresh_token));
  });

  it("stops reading oversized forms at the byte limit", async () => {
    const response = await send(
      `/fixture/form-limit?${new URLSearchParams({ route: "/oauth/continue" })}`,
    );

    expect(await response.json()).toEqual({ status: 400, reads: 2, cancelled: true });
  });

  it("logs unavailable login configuration while returning a safe error page", async () => {
    const auth = await authorize();
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");
    const saved = z.string().parse(await storage.get(mcpLoginKey));
    await storage.delete(mcpLoginKey);
    const first = logs.length;

    try {
      // Only the fallback to Widefleet sign-in needs the shared login configuration.
      const response = await continueWith(auth.handle, "widefleet", {
        authorize: "/authorize?client_id=retry",
      });

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

  it("rejects a different Workspace even when its verified email has a familiar suffix", async () => {
    idp.settings.workspaceDomain = "unconfigured.example.test";

    try {
      const auth = await authorize();
      const start = await continueWithEmail(auth.handle);
      const callback = await companyLogin(z.string().parse(start.headers.get("location")));
      expect(callback.status).toBe(400);
      expect(callback.headers.get("location")).toBeNull();
    } finally {
      idp.settings.workspaceDomain = "example.test";
    }
  });

  it("finds active organizations when the domain index contains suspended, deleted or stale entries", async () => {
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");
    await publish("suspended");
    await storage.put(
      organizationHttpAvailabilityKey("suspended"),
      JSON.stringify({ blocked: true }),
    );
    await publish("deleted");
    await storage.delete(authConfigurationKey("deleted"));
    // The current configuration of "second" no longer lists this domain.
    await storage.put(`${mcpDomainPrefix("example.test")}second`, "second");

    try {
      const auth = await authorize();
      const start = await continueWithEmail(auth.handle);
      const callback = await companyLogin(z.string().parse(start.headers.get("location")));
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
      await storage.delete(organizationHttpAvailabilityKey("suspended"));

      for (const id of ["suspended", "deleted", "second"])
        await storage.delete(`${mcpDomainPrefix("example.test")}${id}`);
    }
  });

  it("does not rewrite shared login credentials when another organization publishes the same registration", async () => {
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");
    const original = await storage.get(mcpLoginKey);
    const configuration = { origin, platformUrl: "https://platform.example.test" };

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
