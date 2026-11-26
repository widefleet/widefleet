import { build } from "esbuild";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { managedOAuth, openAccessToken, type OAuthIdentity } from "./oauth.ts";
import { testKeyring } from "../fixtures/keyring.ts";

// A real authorization server with Client ID Metadata Document support, run in
// workerd. It fetches the broker's document over its outbound connection.
const authorizationServer = `
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

export default new OAuthProvider({
  apiRoute: "https://auth.tracker.example.test/mcp",
  apiHandler: {
    fetch: (request, env, ctx) =>
      Response.json({ user: ctx.props.user, clientName: ctx.props.clientName, scope: ctx.auth?.scope }),
  },
  defaultHandler: {
    async fetch(request, env) {
      if (new URL(request.url).pathname !== "/authorize") return new Response(null, { status: 404 });
      const authorization = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const client = await env.OAUTH_PROVIDER.lookupClient(authorization.clientId);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authorization,
        userId: "alice",
        metadata: {},
        scope: authorization.scope,
        props: { user: "alice", clientName: client?.clientName },
      });

      return Response.redirect(redirectTo, 302);
    },
  },
  authorizeEndpoint: "https://auth.tracker.example.test/authorize",
  tokenEndpoint: "https://auth.tracker.example.test/token",
  scopesSupported: ["read", "write"],
  resourceMetadata: { resource: "https://auth.tracker.example.test/mcp" },
  clientIdMetadataDocumentEnabled: true,
});
`;

const identity: OAuthIdentity = {
  appId: "2a600000-0000-4000-8000-000000000001",
  organizationId: "test-org",
  origin: "https://tracker-team.example.test",
  caller: { issuer: "https://identity.example.test", subject: "alice" },
};

const verifier = "test-pkce-verifier-which-is-at-least-43-characters";

const server = "https://auth.tracker.example.test";

let miniflare: Miniflare;

let environment: Parameters<typeof managedOAuth>[0];

const documentFetches: string[] = [];

beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: authorizationServer, resolveDir: import.meta.dirname, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
  });

  miniflare = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "authorization-server",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: z.string().parse(bundle.outputFiles[0]?.text) },
            },
          },
          env: { OAUTH_KV: { type: "kv", id: "oauth" } },
        },
        dev: {
          // The authorization server's only route out: the broker's public routes.
          outboundService: {
            type: "fetcher",
            handler: async (request) => {
              documentFetches.push(request.url);

              const response = await managedOAuth(environment).handle(
                new Request(request.url, { method: request.method }),
                async () => true,
              );

              return new MiniflareResponse(await response?.text(), {
                status: response?.status ?? 404,
                headers: Object.fromEntries(response?.headers ?? []),
              });
            },
          },
        },
      },
    ],
  });

  const metadata = z
    .object({
      authorization_endpoint: z.url(),
      token_endpoint: z.url(),
      revocation_endpoint: z.url(),
      client_id_metadata_document_supported: z.literal(true),
    })
    .parse(
      await (
        await miniflare.dispatchFetch(`${server}/.well-known/oauth-authorization-server`)
      ).json(),
    );

  environment = {
    WIDEFLEET_SECRETS_KEYS: testKeyring(),
    WIDEFLEET_OAUTH: JSON.stringify({
      origin: "https://oauth.example.test",
      clients: {
        tracker: {
          registration: "client-id-metadata-document",
          authorizationUrl: metadata.authorization_endpoint,
          tokenUrl: metadata.token_endpoint,
          revocationUrl: metadata.revocation_endpoint,
          resource: `${server}/mcp`,
          scopes: ["read", "write"],
          hosts: [server],
        },
      },
    }),
  };

  // The broker's token requests reach the authorization server in workerd.
  const original = globalThis.fetch;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);

    if (new URL(request.url).origin !== server) return original(input, init);

    const response = await miniflare.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
      redirect: "manual",
    });

    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await miniflare?.dispose();
});

describe("managed OAuth against an authorization server with metadata document support", () => {
  it("signs in, refreshes and calls the resource without registering a client", async () => {
    const broker = managedOAuth(environment);

    const authorization = new URL(
      z.object({ url: z.url() }).parse(
        await broker.request(identity, {
          action: "authorize",
          client: "tracker",
          scopes: ["read"],
          state: "local-state",
          codeVerifier: verifier,
        }),
      ).url,
    );

    const consent = await miniflare.dispatchFetch(authorization.href, { redirect: "manual" });

    expect(consent.status).toBe(302);
    expect(documentFetches).toContain("https://oauth.example.test/oauth/client-metadata.json");
    const callback = new URL(z.string().parse(consent.headers.get("location")));

    expect(`${callback.origin}${callback.pathname}`).toBe(
      "https://oauth.example.test/oauth/callback/tracker",
    );

    const relayed = await broker.handle(new Request(callback), async () => true);
    const destination = new URL(z.string().parse(relayed?.headers.get("location")));

    expect(destination.pathname).toBe("/auth/callback/tracker");

    const tokens = z.object({ accessToken: z.string(), refreshToken: z.string() });

    const granted = tokens.parse(
      await broker.request(identity, {
        action: "exchange",
        client: "tracker",
        ticket: z.string().parse(destination.searchParams.get("managed_state")),
        code: z.string().parse(destination.searchParams.get("code")),
        codeVerifier: verifier,
      }),
    );

    const call = async (placeholder: string) => {
      const token = await openAccessToken(
        environment,
        identity.appId,
        placeholder,
        new URL(`${server}/mcp`),
      );

      return miniflare.dispatchFetch(`${server}/mcp`, {
        headers: { authorization: `Bearer ${z.string().parse(token)}` },
      });
    };

    const resource = await call(granted.accessToken);

    expect(resource.status).toBe(200);
    // The server named the client from the published document.
    expect(await resource.json()).toMatchObject({
      user: "alice",
      clientName: "Widefleet",
      scope: ["read"],
    });

    const refreshed = tokens.partial({ refreshToken: true }).parse(
      await broker.request(identity, {
        action: "refresh",
        client: "tracker",
        refreshToken: granted.refreshToken,
      }),
    );

    expect((await call(refreshed.accessToken)).status).toBe(200);

    expect(
      await broker.request(identity, {
        action: "revoke",
        client: "tracker",
        token: refreshed.refreshToken ?? granted.refreshToken,
      }),
    ).toEqual({ revoked: true });
    expect((await call(refreshed.accessToken)).status).toBe(401);
  });
});
