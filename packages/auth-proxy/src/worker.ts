import type { KVNamespace } from "@cloudflare/workers-types";
import {
  connectorBrowserRoute,
  connectorCaller,
  organizationIdentifier,
} from "@platform/contracts";
import type { z } from "zod";
import { authConfiguration } from "./configuration.ts";
import {
  authControlPath,
  authConfigurationKey,
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

const configuration = async (environment: AuthEnvironment, organizationId: string) => {
  const value = await environment.AUTH_CONFIG.get(authConfigurationKey(organizationId));

  if (!value) return null;
  const stored = await decodeConfiguration(environment.WIDEFLEET_CONTROL_TOKEN, value);

  if (stored.configuration.organizationId !== organizationId)
    throw new Error("Sign-in configuration belongs to a different organization");

  return stored;
};

const control = async (request: Request, environment: AuthEnvironment) => {
  const path = new URL(request.url).pathname.slice(authControlPath.length);

  const match = /^\/organizations\/([A-Za-z0-9_-]+)\/configuration$/.exec(path);

  if (match) {
    const organizationId = organizationIdentifier.parse(match[1]);

    if (request.method === "GET") {
      const current = await configuration(environment, organizationId);

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

      if (input.organizationId !== organizationId)
        return reply(400, "Organization does not match configuration");
      await environment.AUTH_CONFIG.put(
        authConfigurationKey(organizationId),
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

// The caller must authorize the request or expose this only through a private service binding.
export const manageAuthConfiguration = async (request: Request, environment: AuthEnvironment) => {
  try {
    if (environment.WIDEFLEET_CONTROL_TOKEN.length < 32)
      throw new Error("Auth configuration encryption key is missing or too short");

    return await control(request, environment);
  } catch {
    console.error("Auth proxy operation failed", { phase: "control" });

    return reply(503, "Auth configuration could not be applied");
  }
};

export const createAuthHandler = (
  environment: AuthEnvironment,
  runApp: (
    request: Request,
    appId: string,
    organizationId: string,
    caller: z.infer<typeof connectorCaller>,
  ) => Promise<Response>,
  runConnector?: (
    request: Request,
    appId: string,
    organizationId: string,
    caller: z.infer<typeof connectorCaller>,
    binding: string,
  ) => Promise<Response>,
  browser?: {
    resolve: (hostname: string) => Promise<z.infer<typeof connectorBrowserRoute> | null>;
    fetch: (
      request: Request,
      route: z.infer<typeof connectorBrowserRoute>,
      caller: z.infer<typeof connectorCaller>,
    ) => Promise<Response>;
  },
) => ({
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(`${authControlPath}/`)) {
      if (
        environment.WIDEFLEET_CONTROL_TOKEN.length < 32 ||
        request.headers.get("authorization") !== `Bearer ${environment.WIDEFLEET_CONTROL_TOKEN}`
      )
        return reply(403, "Forbidden");

      return manageAuthConfiguration(request, environment);
    }

    let phase = "app-route";

    try {
      const routes = new Map<
        string,
        Promise<z.infer<typeof authRoute> | z.infer<typeof connectorBrowserRoute> | null>
      >();

      const resolve = (hostname: string) => {
        phase = "app-route";
        let route = routes.get(hostname);

        if (!route) {
          route = environment.AUTH_CONFIG.get(authRouteKey(hostname)).then(async (value) =>
            value
              ? authRoute.parse(JSON.parse(value))
              : ((await browser?.resolve(hostname)) ?? null),
          );
          routes.set(hostname, route);
        }

        return route;
      };

      const route = await resolve(url.hostname);

      // App hostnames select their owner from the published route. Only the auth
      // host can dispatch by callback path; the proxy checks that host below.
      const callback = /^\/oauth2\/([A-Za-z0-9_-]+)\/(?:start|callback|error|sign_out)$/.exec(
        url.pathname,
      );

      const organizationId = route?.organizationId ?? callback?.[1];

      if (!organizationId) return reply(404, "Not found");
      phase = "configuration";
      const installed = await configuration(environment, organizationId);

      if (!installed)
        return route
          ? reply(503, "Organization sign-in is not configured")
          : reply(404, "Not found");

      const proxy = createAuthProxy(installed.configuration, {
        browser: Boolean(route && !("appId" in route)),
        resolve: async (hostname) => {
          const route = await resolve(hostname);
          phase = "authentication";

          return route?.organizationId === organizationId
            ? "appId" in route
              ? route.access
              : { revision: 0, groups: [] }
            : null;
        },
        fetch: async (forwarded, caller) => {
          const route = await resolve(new URL(forwarded.url).hostname);

          if (!route || route.organizationId !== organizationId) return reply(404, "Not found");
          phase = "app-runtime";

          if ("appId" in route) return runApp(forwarded, route.appId, organizationId, caller);

          return browser ? browser.fetch(forwarded, route, caller) : reply(404, "Not found");
        },
        connector: async (forwarded, caller, binding) => {
          const route = await resolve(new URL(forwarded.url).hostname);

          if (
            !route ||
            !("appId" in route) ||
            route.organizationId !== organizationId ||
            !runConnector
          )
            return reply(404, "Not found");
          phase = "app-runtime";

          return runConnector(forwarded, route.appId, organizationId, caller, binding);
        },
      });

      phase = "authentication";
      const response = await proxy.fetch(request);
      const resolved = await routes.get(url.hostname);

      if (resolved && "appId" in resolved)
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
