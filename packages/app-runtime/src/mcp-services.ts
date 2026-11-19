import { mcpServiceCall, hasAppAccess, type mcpClaims } from "@platform/contracts";
import type { z } from "zod";
import { readApp, readServiceDocumentation } from "./catalog.ts";
import { serviceRoute, verifyMcpToken } from "./mcp-authorization.ts";
import { appWorker } from "./worker.ts";
import { invokeApp } from "./app-rpc.ts";
import { signAppCaller } from "./app-caller.ts";
import { executionOptions } from "./execution-limits.ts";
import { rankServices, type SearchRequest } from "./mcp-search.ts";
import { readServiceIndex } from "./service-index.ts";
import type { ParentEnvironment } from "./types.ts";

const target = async (
  environment: ParentEnvironment,
  claims: z.infer<typeof mcpClaims>,
  hostname: string,
  entrypoint: string,
) => {
  const route = await serviceRoute(environment, hostname);

  if (
    !route ||
    route.organizationId !== claims.mcp.organizationId ||
    !hasAppAccess(route.access.groups, claims.mcp.identity.groups)
  )
    throw new Error("Service is unavailable or not permitted");

  const app = await readApp(environment, `hosts/${hostname}.json`, {
    appId: route.appId,
    organizationId: route.organizationId,
  });

  if (
    !app ||
    app.appId !== route.appId ||
    app.organizationId !== route.organizationId ||
    !app.metadata.entrypoints?.includes(entrypoint)
  )
    throw new Error("Service is unavailable or not permitted");

  return app;
};

export const searchMcpServices = async (
  environment: ParentEnvironment,
  claims: z.infer<typeof mcpClaims>,
  request: SearchRequest,
) => {
  const { services, complete } = await readServiceIndex(environment, claims.mcp.organizationId);

  const permitted = Object.entries(services).flatMap(([hostname, service]) =>
    hasAppAccess(service.access.groups, claims.mcp.identity.groups)
      ? service.entrypoints.map((entrypoint) => ({
          appId: service.appId,
          hostname,
          entrypoint: entrypoint.name,
          summary: entrypoint.summary,
          terms: entrypoint.terms,
        }))
      : [],
  );

  const page = rankServices(permitted, request);

  // The index can trail a failed refresh. Authorize each returned service against
  // its current route; describe and call check it again.
  const hostnames = [...new Set(page.services.map((service) => service.hostname))];

  const allowed = new Set(
    (
      await Promise.all(
        hostnames.map(async (hostname) => {
          const route = await serviceRoute(environment, hostname);

          return route &&
            route.organizationId === claims.mcp.organizationId &&
            route.appId === services[hostname]?.appId &&
            hasAppAccess(route.access.groups, claims.mcp.identity.groups)
            ? [hostname]
            : [];
        }),
      )
    ).flat(),
  );

  return {
    ...page,
    complete,
    services: page.services.flatMap(({ appId, hostname, entrypoint, summary }) =>
      allowed.has(hostname) ? [{ appId, hostname, entrypoint, summary }] : [],
    ),
  };
};

export const describeMcpService = async (
  environment: ParentEnvironment,
  claims: z.infer<typeof mcpClaims>,
  hostname: string,
  entrypoint: string,
) => {
  const app = await target(environment, claims, hostname, entrypoint);
  const documentation = await readServiceDocumentation(environment, app);

  return {
    appId: app.appId,
    hostname,
    entrypoint,
    documentation: documentation?.entrypoints.find((entry) => entry.name === entrypoint) ?? null,
    types: documentation?.types ?? [],
  };
};

export const callMcpService = async (
  environment: ParentEnvironment,
  context: ExecutionContext,
  token: string,
  input: z.infer<typeof mcpServiceCall>,
) => {
  // Recheck the published policy on every subcall, including calls from code mode.
  const claims = await verifyMcpToken(environment, token);
  const app = await target(environment, claims, input.hostname, input.entrypoint);

  const caller = {
    issuer: claims.mcp.identity.issuer,
    subject: claims.mcp.identity.subject,
    name: claims.mcp.identity.name,
  };

  const proof = await signAppCaller(
    environment.WIDEFLEET_CONTROL_TOKEN,
    app.appId,
    claims.mcp.organizationId,
    caller,
    claims.exp * 1000,
  );

  const worker = await appWorker(app, environment, context);

  return invokeApp(
    worker.getEntrypoint(input.entrypoint === "default" ? undefined : input.entrypoint, {
      ...executionOptions(environment.WIDEFLEET_EXECUTION_LIMITS, "service"),
      props: { caller, appCaller: proof },
    }),
    input.method,
    input.arguments,
  );
};
