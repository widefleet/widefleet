import {
  mcpServiceCall,
  hasAppAccess,
  type InputAnswer,
  type mcpClaims,
} from "@platform/contracts";
import type { z } from "zod";
import { readApp, readServiceDocumentation } from "./catalog.ts";
import { serviceRoute, verifyMcpToken } from "./mcp-authorization.ts";
import { appWorker } from "./worker.ts";
import { invokeApp } from "./app-rpc.ts";
import { openInput, rebindInput, requestedInput, sealInput } from "./service-input.ts";
import { signAppCaller } from "./app-caller.ts";
import { executionOptions } from "./execution-limits.ts";
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
  query: string,
  cursor?: string,
) => {
  // At most 10 apps × 32 entrypoints with short excerpts fits the 1 MiB response
  // limit even with JSON escaping. Search the full text; describe returns it.
  const options: KVNamespaceListOptions = { prefix: "apps/", limit: 10 };

  if (cursor) options.cursor = cursor;
  const page = await environment.AUTH_CONFIG.list(options);

  const entries = await Promise.all(
    page.keys.map(async ({ name }) => {
      const hostname = name.slice("apps/".length);
      const route = await serviceRoute(environment, hostname);

      if (
        !route ||
        route.organizationId !== claims.mcp.organizationId ||
        !hasAppAccess(route.access.groups, claims.mcp.identity.groups)
      )
        return [];

      const app = await readApp(environment, `hosts/${hostname}.json`, {
        appId: route.appId,
        organizationId: route.organizationId,
      });

      if (!app || app.appId !== route.appId || app.organizationId !== route.organizationId)
        return [];

      const entrypoints = app.metadata.entrypoints ?? [];

      if (!entrypoints.length) return [];
      const docs = await readServiceDocumentation(environment, app);

      return entrypoints.flatMap((entrypoint) => {
        const documentation = docs?.entrypoints.find((entry) => entry.name === entrypoint);

        const summary = documentation?.summary ?? "";

        if (![hostname, entrypoint, summary].join(" ").toLowerCase().includes(query.toLowerCase()))
          return [];

        return [{ appId: app.appId, hostname, entrypoint, summary: summary.slice(0, 256) }];
      });
    }),
  );

  return { services: entries.flat(), cursor: page.list_complete ? null : page.cursor };
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

// A question is answered either through the MCP client's own dialog or through
// the form the gateway shows in the client. State minted for one channel never
// answers through the other, so the agent cannot use the form's answer path
// with state it relays from a call result.
export type McpInputChannel = "client" | "form";

const authorizeCall = async (
  environment: ParentEnvironment,
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

  return {
    claims,
    app,
    caller,
    // Answers belong to the signed-in person and to this exact call.
    binding: (channel: McpInputChannel) =>
      JSON.stringify([
        channel === "client" ? "mcp" : "mcp-form",
        claims.mcp.organizationId,
        caller.issuer,
        caller.subject,
      ]),
    call: {
      appId: app.appId,
      entrypoint: input.entrypoint,
      method: input.method,
      args: input.arguments,
    },
  };
};

// `answer` carries the responses when a call that asked for input is retried.
export const callMcpService = async (
  environment: ParentEnvironment,
  context: ExecutionContext,
  token: string,
  input: z.infer<typeof mcpServiceCall>,
  answer?: InputAnswer,
  channel: McpInputChannel = "client",
) => {
  const { claims, app, caller, binding, call } = await authorizeCall(environment, token, input);

  const proof = await signAppCaller(
    environment.WIDEFLEET_CONTROL_TOKEN,
    app.appId,
    claims.mcp.organizationId,
    caller,
    claims.exp * 1000,
  );

  const secret = environment.WIDEFLEET_CONTROL_TOKEN;

  const props =
    answer === undefined
      ? { caller, appCaller: proof }
      : {
          caller,
          appCaller: proof,
          input: await openInput(secret, binding(channel), call, answer),
        };

  const worker = await appWorker(app, environment, context);

  const value = await invokeApp(
    worker.getEntrypoint(input.entrypoint === "default" ? undefined : input.entrypoint, {
      ...executionOptions(environment.WIDEFLEET_EXECUTION_LIMITS, "service"),
      props,
    }),
    input.method,
    input.arguments,
  );

  const question = requestedInput(value);

  return question ? sealInput(secret, binding(channel), call, question) : value;
};

// Move a question from a call result to the form, which only the person answers.
export const formMcpInput = async (
  environment: ParentEnvironment,
  token: string,
  input: z.infer<typeof mcpServiceCall>,
  requestState: string,
) => {
  const { binding, call } = await authorizeCall(environment, token, input);

  return rebindInput(
    environment.WIDEFLEET_CONTROL_TOKEN,
    binding("client"),
    binding("form"),
    call,
    requestState,
  );
};
