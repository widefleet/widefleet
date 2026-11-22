import { serviceTarget } from "./service-target.ts";
import {
  mcpServiceCall,
  hasAppAccess,
  selectServiceMethods,
  type InputAnswer,
  type mcpClaims,
} from "@platform/contracts";
import type { z } from "zod";
import { readServiceDocumentation } from "./catalog.ts";
import { serviceRoute, verifyMcpToken } from "./mcp-authorization.ts";
import { appWorker } from "./worker.ts";
import { invokeApp } from "./app-rpc.ts";
import { openInput, rebindInput, requestedInput, sealInput } from "./service-input.ts";
import { signAppCaller } from "./app-caller.ts";
import { executionOptions } from "./execution-limits.ts";
import { rankMethods, type SearchRequest } from "./mcp-search.ts";
import { readServiceIndex } from "./service-index.ts";
import type { ParentEnvironment } from "./types.ts";

const target = async (
  environment: ParentEnvironment,
  claims: z.infer<typeof mcpClaims>,
  hostname: string,
  entrypoint: string,
) => {
  const app = await serviceTarget(
    environment,
    claims.mcp.organizationId,
    claims.mcp.identity,
    hostname,
    entrypoint,
  );

  if (!app) throw new Error("Service is unavailable or not permitted");

  return app;
};

export const searchMcpMethods = async (
  environment: ParentEnvironment,
  claims: z.infer<typeof mcpClaims>,
  request: SearchRequest,
) => {
  const { services, complete } = await readServiceIndex(environment, claims.mcp.organizationId);

  const permitted = Object.entries(services).flatMap(([hostname, service]) =>
    hasAppAccess(service.access.groups, claims.mcp.identity.groups)
      ? service.entrypoints.flatMap((entrypoint) =>
          entrypoint.methods.map((method) => ({
            appId: service.appId,
            hostname,
            entrypoint: entrypoint.name,
            method: method.name,
            summary: method.summary,
            terms: method.terms,
          })),
        )
      : [],
  );

  const page = rankMethods(permitted, request);

  // The index can trail a failed refresh. Authorize each returned service against
  // its current route; describe and call check it again.
  const hostnames = [...new Set(page.methods.map((method) => method.hostname))];

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
    methods: page.methods.flatMap(({ appId, hostname, entrypoint, method, summary }) =>
      allowed.has(hostname) ? [{ appId, hostname, entrypoint, method, summary }] : [],
    ),
  };
};

export const describeMcpMethods = async (
  environment: ParentEnvironment,
  claims: z.infer<typeof mcpClaims>,
  hostname: string,
  entrypoint: string,
  request: { methods: string[]; types: string[] },
) => {
  const app = await target(environment, claims, hostname, entrypoint);
  const documentation = await readServiceDocumentation(environment, app);

  if (!documentation)
    throw new Error(`${hostname} has no API documentation; deploy it with the current CLI`);
  const { selection, unknown } = selectServiceMethods(documentation, entrypoint, request);

  if (unknown.entrypoint)
    throw new Error(
      `${entrypoint} on ${hostname} is not a documented entrypoint. ` +
        "Search with this hostname to list its entrypoints and methods.",
    );

  if (unknown.methods.length)
    throw new Error(
      `${entrypoint} on ${hostname} has no documented method ${unknown.methods.join(", ")}. ` +
        "Search with this hostname and entrypoint to list its methods.",
    );

  if (!selection)
    throw new Error(
      `${hostname} has no documented type ${unknown.types.join(", ")}. ` +
        "Describe a method first; its types, uses and omittedTypes name the documented types.",
    );

  return {
    appId: app.appId,
    hostname,
    entrypoint,
    documentation: selection.entrypoint,
    types: selection.types,
    omittedTypes: selection.omittedTypes,
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
