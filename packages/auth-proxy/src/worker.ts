import type { KVNamespace } from "@cloudflare/workers-types";
import { organizationIdentifier, type appCaller } from "@platform/contracts";
import { z } from "zod";
import { authConfiguration, type AuthConfiguration } from "./configuration.ts";
import {
  authControlPath,
  authConfigurationKey,
  authRoute,
  authRouteKey,
  decodeConfiguration,
  encodeConfiguration,
} from "./publication.ts";
import { createAuthProxy } from "./proxy.ts";
import {
  encodeMcpLogin,
  decodeMcpLogin,
  mcpLoginConfiguration,
  mcpDomainKeys,
  mcpLoginKey,
  mcpOrganizationKey,
} from "./mcp-login.ts";

export interface AuthEnvironment {
  AUTH_CONFIG: KVNamespace;
  WIDEFLEET_CONTROL_TOKEN: string;
}

const reply = (status: number, message: string) =>
  new Response(status === 204 ? null : message, {
    status,
    headers: { "cache-control": "no-store" },
  });

// KV keys through which the MCP sign-in finds an organization without the control plane.
const discoveryKeys = (configuration: AuthConfiguration) => [
  ...new Set(
    [mcpOrganizationKey(configuration), ...mcpDomainKeys(configuration)].filter(
      (key) => key !== null,
    ),
  ),
];

const discoveryListKey = (organizationId: string) =>
  `organizations/${organizationIdentifier.parse(organizationId)}/discovery`;

const discoveryList = z.array(z.string().regex(/^mcp\/(?:organizations|domains)\//));

// Every index key that may exist for the organization, including keys that a
// failed publication wrote. Earlier releases kept no list; derive theirs.
const listedDiscoveryKeys = async (environment: AuthEnvironment, organizationId: string) => {
  const stored = await environment.AUTH_CONFIG.get(discoveryListKey(organizationId));

  if (stored) return { stored: true, keys: discoveryList.parse(JSON.parse(stored)) };
  const previous = await readAuthConfiguration(environment, organizationId);

  return { stored: false, keys: previous ? discoveryKeys(previous.configuration) : [] };
};

export const readAuthConfiguration = async (
  environment: AuthEnvironment,
  organizationId: string,
) => {
  const value = await environment.AUTH_CONFIG.get(authConfigurationKey(organizationId));

  if (!value) return null;
  const stored = await decodeConfiguration(environment.WIDEFLEET_CONTROL_TOKEN, value);

  if (stored.configuration.organizationId !== organizationId)
    throw new Error("Sign-in configuration belongs to a different organization");

  return stored;
};

const control = async (request: Request, environment: AuthEnvironment) => {
  const path = new URL(request.url).pathname.slice(authControlPath.length);

  if (path === "/mcp/login" && request.method === "PUT") {
    const input = mcpLoginConfiguration.parse(await request.json());
    const stored = await environment.AUTH_CONFIG.get(mcpLoginKey);

    // Every organization publication includes this installation-wide registration.
    // Avoid spending the shared KV key's write quota on unchanged credentials.
    if (stored) {
      const current = await decodeMcpLogin(environment.WIDEFLEET_CONTROL_TOKEN, stored);

      if (JSON.stringify(current) === JSON.stringify(input)) return reply(204, "");
    }

    await environment.AUTH_CONFIG.put(
      mcpLoginKey,
      await encodeMcpLogin(environment.WIDEFLEET_CONTROL_TOKEN, input),
    );

    return reply(204, "");
  }

  const match = /^\/organizations\/([A-Za-z0-9_-]+)\/configuration$/.exec(path);

  if (match) {
    const organizationId = organizationIdentifier.parse(match[1]);

    if (request.method === "GET") {
      const current = await readAuthConfiguration(environment, organizationId);

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
      const listed = await listedDiscoveryKeys(environment, organizationId);
      const current = discoveryKeys(input);
      const pending = [...new Set([...listed.keys, ...current])];
      const listKey = discoveryListKey(organizationId);
      // Record keys before writing them, so a failed publication leaves its cleanup
      // to the next publication or revocation. KV accepts one write per key and
      // second, so a list that only shrinks is written at the end instead.
      const recorded = !listed.stored || pending.length !== listed.keys.length;

      if (recorded) await environment.AUTH_CONFIG.put(listKey, JSON.stringify(pending));

      await environment.AUTH_CONFIG.put(
        authConfigurationKey(organizationId),
        await encodeConfiguration(environment.WIDEFLEET_CONTROL_TOKEN, input),
      );

      for (const key of current) await environment.AUTH_CONFIG.put(key, organizationId);

      for (const key of listed.keys)
        if (!current.includes(key)) await environment.AUTH_CONFIG.delete(key);

      if (!recorded && current.length !== listed.keys.length)
        await environment.AUTH_CONFIG.put(listKey, JSON.stringify(current));

      return reply(204, "");
    }

    if (request.method === "DELETE") {
      const listed = await listedDiscoveryKeys(environment, organizationId);

      // Revoke sign-in first. A failed index cleanup must not keep the provider trusted;
      // the list remains, so a retry removes the rest.
      await environment.AUTH_CONFIG.delete(authConfigurationKey(organizationId));

      for (const key of listed.keys) await environment.AUTH_CONFIG.delete(key);

      await environment.AUTH_CONFIG.delete(discoveryListKey(organizationId));

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
    caller: z.infer<typeof appCaller>,
  ) => Promise<Response>,
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

      const route = await resolve(url.hostname);

      // App hostnames select their owner from the published route. Only the auth
      // host can dispatch by callback path; the proxy checks that host below.
      const callback = /^\/oauth2\/([A-Za-z0-9_-]+)\/(?:start|callback|error|sign_out)$/.exec(
        url.pathname,
      );

      const organizationId = route?.organizationId ?? callback?.[1];

      if (!organizationId) return reply(404, "Not found");
      phase = "configuration";
      const installed = await readAuthConfiguration(environment, organizationId);

      if (!installed)
        return route
          ? reply(503, "Organization sign-in is not configured")
          : reply(404, "Not found");

      const proxy = createAuthProxy(installed.configuration, {
        resolve: async (hostname) => {
          const route = await resolve(hostname);
          phase = "authentication";

          return route?.organizationId === organizationId ? route.access : null;
        },
        fetch: async (forwarded, caller) => {
          const route = await resolve(new URL(forwarded.url).hostname);

          if (!route || route.organizationId !== organizationId) return reply(404, "Not found");
          phase = "app-runtime";

          return runApp(forwarded, route.appId, route.organizationId, caller);
        },
      });

      phase = "authentication";
      const response = await proxy.fetch(request);
      const resolved = await routes.get(url.hostname);

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
