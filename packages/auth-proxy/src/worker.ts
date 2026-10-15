import type { KVNamespace } from "@cloudflare/workers-types";
import { authConfiguration } from "./configuration.ts";
import {
  authControlPath,
  authRoute,
  authRouteKey,
  decodeConfiguration,
  encodeConfiguration,
} from "./publication.ts";
import { createAuthProxy } from "./proxy.ts";

export interface AuthProxyEnvironment {
  AUTH_CONFIG: KVNamespace;
  AUTH_PROXY_KEY: string;
  APP_RUNTIME?: { fetch: typeof fetch };
}

const reply = (status: number, message: string) =>
  new Response(status === 204 ? null : message, {
    status,
    headers: { "cache-control": "no-store" },
  });

const configuration = async (environment: AuthProxyEnvironment) => {
  const value = await environment.AUTH_CONFIG.get("configuration");

  return value ? decodeConfiguration(environment.AUTH_PROXY_KEY, value) : null;
};

const control = async (request: Request, environment: AuthProxyEnvironment) => {
  if (
    environment.AUTH_PROXY_KEY.length < 32 ||
    request.headers.get("authorization") !== `Bearer ${environment.AUTH_PROXY_KEY}`
  )
    return reply(403, "Forbidden");
  const path = new URL(request.url).pathname.slice(authControlPath.length);

  if (path === "/configuration") {
    if (request.method === "GET") {
      const current = await configuration(environment);

      return Response.json(
        current
          ? {
              revision: current.revision,
              state: "active",
              message:
                "The sign-in configuration is published. KV propagation may delay its visibility.",
            }
          : {
              revision: "",
              state: "waiting",
              message: "Waiting for company sign-in configuration",
            },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (request.method === "PUT") {
      const input = authConfiguration.parse(await request.json());
      await environment.AUTH_CONFIG.put(
        "configuration",
        await encodeConfiguration(environment.AUTH_PROXY_KEY, input),
      );

      return reply(204, "");
    }
  }

  if (path.startsWith("/apps/")) {
    const key = authRouteKey(path.slice("/apps/".length));

    if (request.method === "PUT") {
      const route = authRoute.parse(await request.json());
      await environment.AUTH_CONFIG.put(key, JSON.stringify(route));

      return reply(204, "");
    }

    if (request.method === "DELETE") {
      await environment.AUTH_CONFIG.delete(key);

      return reply(204, "");
    }
  }

  return reply(404, "Not found");
};

export default {
  async fetch(request: Request, environment: AuthProxyEnvironment) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(`${authControlPath}/`)) {
      try {
        return await control(request, environment);
      } catch {
        return reply(503, "Auth configuration could not be applied");
      }
    }

    try {
      const installed = await configuration(environment);

      if (!installed) return reply(503, "Company sign-in is not configured");
      const routes = new Map<string, Promise<ReturnType<typeof authRoute.parse> | null>>();

      const resolve = (hostname: string) => {
        let route = routes.get(hostname);

        if (!route) {
          route = environment.AUTH_CONFIG.get(authRouteKey(hostname)).then((value) =>
            value ? authRoute.parse(JSON.parse(value)) : null,
          );
          routes.set(hostname, route);
        }

        return route;
      };

      const proxy = createAuthProxy(installed.configuration, {
        resolve: async (hostname) => (await resolve(hostname))?.access ?? null,
        fetch: async (forwarded) => {
          const route = await resolve(new URL(forwarded.url).hostname);

          if (!route) return reply(404, "Not found");
          const headers = new Headers(forwarded.headers);

          // A stale KV route must never authorize a different app reusing this hostname.
          headers.set("x-widefleet-app-id", route.appId);

          if (environment.APP_RUNTIME)
            return environment.APP_RUNTIME.fetch(new Request(forwarded, { headers }));

          if (!route.upstream) return reply(503, "App runtime is not connected");
          const source = new URL(forwarded.url);
          const target = new URL(route.upstream);

          target.pathname = source.pathname;
          target.search = source.search;

          headers.set("x-forwarded-host", source.host);
          headers.set("x-forwarded-proto", source.protocol.slice(0, -1));

          return fetch(
            new Request(target, new Request(forwarded, { headers, redirect: "manual" })),
          );
        },
      });

      const response = await proxy.fetch(request);
      const route = routes.get(url.hostname);
      const resolved = route ? await route : null;

      if (resolved)
        response.headers.set(
          "x-widefleet-access-revision",
          `${resolved.appId}:${resolved.access.revision}`,
        );

      return response;
    } catch {
      return reply(503, "Company sign-in is temporarily unavailable");
    }
  },
};
