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

export interface AuthEnvironment {
  AUTH_CONFIG: KVNamespace;
  WIDEFLEET_CONTROL_TOKEN: string;
}

const reply = (status: number, message: string) =>
  new Response(status === 204 ? null : message, {
    status,
    headers: { "cache-control": "no-store" },
  });

const configuration = async (environment: AuthEnvironment) => {
  const value = await environment.AUTH_CONFIG.get("configuration");

  return value ? decodeConfiguration(environment.WIDEFLEET_CONTROL_TOKEN, value) : null;
};

const control = async (request: Request, environment: AuthEnvironment) => {
  if (
    environment.WIDEFLEET_CONTROL_TOKEN.length < 32 ||
    request.headers.get("authorization") !== `Bearer ${environment.WIDEFLEET_CONTROL_TOKEN}`
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
        await encodeConfiguration(environment.WIDEFLEET_CONTROL_TOKEN, input),
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

export const createAuthHandler = (
  environment: AuthEnvironment,
  runApp: (request: Request, appId: string) => Promise<Response>,
) => ({
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(`${authControlPath}/`)) {
      try {
        return await control(request, environment);
      } catch {
        console.error("Auth proxy operation failed", { phase: "control" });

        return reply(503, "Auth configuration could not be applied");
      }
    }

    let phase = "configuration";

    try {
      const installed = await configuration(environment);

      if (!installed) return reply(503, "Company sign-in is not configured");
      const routes = new Map<string, Promise<ReturnType<typeof authRoute.parse> | null>>();

      const resolve = (hostname: string) => {
        phase = "app-route";
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
        resolve: async (hostname) => {
          const route = await resolve(hostname);
          phase = "authentication";

          return route?.access ?? null;
        },
        fetch: async (forwarded) => {
          const route = await resolve(new URL(forwarded.url).hostname);

          if (!route) return reply(404, "Not found");
          phase = "app-runtime";

          return runApp(forwarded, route.appId);
        },
      });

      phase = "authentication";
      const response = await proxy.fetch(request);
      const route = routes.get(url.hostname);
      const resolved = route ? await route : null;

      if (resolved)
        response.headers.set(
          "x-widefleet-access-revision",
          `${resolved.appId}:${resolved.access.revision}`,
        );

      return response;
    } catch (cause) {
      if (phase === "app-runtime") throw cause;
      console.error("Auth proxy operation failed", { phase });

      return reply(503, "Company sign-in is temporarily unavailable");
    }
  },
});
