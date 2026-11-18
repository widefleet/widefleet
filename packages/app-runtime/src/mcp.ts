import {
  createMcpHandler,
  createRequestStateCodec,
  McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { mcpServiceCall, mcpScopes } from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { verifyMcpToken } from "./mcp-authorization.ts";
import { readMcpConfiguration } from "./mcp-oauth.ts";
import {
  describeMcpService,
  invokeMcpService,
  mcpServiceApp,
  searchMcpServices,
} from "./mcp-services.ts";
import { executeMcpCode, mcpJson } from "./mcp-code.ts";
import {
  answerWorkflow,
  presentWorkflow,
  workflowAnswers,
  workflowInstanceStatus,
  workflowReference,
  workflowRound,
  type WorkflowInstanceAccess,
  type WorkflowOutcome,
  type WorkflowRound,
  type WorkflowTarget,
} from "./mcp-workflows.ts";
import { workflowCatalog } from "./workflow-catalog.ts";

const resultSchema = mcpJson.transform((value) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
}));

const result = resultSchema.parse.bind(resultSchema);

const respond = (outcome: WorkflowOutcome) =>
  "input" in outcome ? outcome.input : result(outcome.value);

// A dedicated key keeps request state signatures apart from other uses of the control token.
const requestStateKey = async (secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode("widefleet-mcp-request-state/v1"),
    ),
  );
};

export const mcpRequest = async (
  request: Request,
  environment: ParentEnvironment,
  context: ExecutionContext,
) => {
  const url = new URL(request.url);

  if (!["/mcp", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname)) return null;
  const configuration = readMcpConfiguration(environment);

  if (!configuration || url.origin !== new URL(configuration.resource).origin) return null;
  const metadata = `${url.origin}/.well-known/oauth-protected-resource/mcp`;

  if (url.pathname !== "/mcp") {
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });

    return new Response(
      request.method === "HEAD"
        ? null
        : JSON.stringify({
            resource: configuration.resource,
            authorization_servers: [configuration.issuer],
            bearer_methods_supported: ["header"],
            scopes_supported: mcpScopes,
          }),
      { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } },
    );
  }

  const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "";
  let claims;

  try {
    claims = await verifyMcpToken(environment, token);
  } catch {
    return new Response("Authentication required", {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${metadata}"`,
        "cache-control": "no-store",
      },
    });
  }

  const principal = claims;

  // Workflow answers round-trip through the client: sign them for this principal.
  const codec = createRequestStateCodec<WorkflowRound>({
    key: await requestStateKey(environment.WIDEFLEET_CONTROL_TOKEN),
    ttlSeconds: 15 * 60,
    bind: () =>
      JSON.stringify([
        principal.mcp.organizationId,
        principal.mcp.identity.issuer,
        principal.mcp.identity.subject,
      ]),
  });

  const instance = (target: WorkflowTarget): WorkflowInstanceAccess => {
    const catalog = workflowCatalog(environment, target.appId);
    const scope = { appId: target.appId, hostname: target.hostname, workflow: target.workflow };

    return {
      status: async () =>
        workflowInstanceStatus.parse(await catalog.instance(scope, target.id, "status")),
      async sendEvent(requestId, event) {
        await catalog.manage(scope, requestId, {
          action: "sendEvent",
          workflow: target.workflow,
          id: target.id,
          event,
        });
      },
    };
  };

  const present = (target: WorkflowTarget, context: ServerContext, era: "legacy" | "modern") =>
    presentWorkflow(
      target,
      instance(target),
      era === "modern" ? (round) => codec.mint(round, context) : undefined,
    );

  // A retried call answers the Workflow from the signed round; the service is
  // not invoked again, but access to it is checked again.
  const resume = async (context: ServerContext) => {
    const round = workflowRound.parse(context.mcpReq.requestState());
    const current = await verifyMcpToken(environment, token);
    const app = await mcpServiceApp(environment, current, round.hostname, round.entrypoint);

    if (app.appId !== round.appId) throw new Error("Service is unavailable or not permitted");

    return respond(
      await answerWorkflow(
        round,
        workflowAnswers.parse(context.mcpReq.inputResponses ?? {}),
        instance(round),
        (next) => codec.mint(next, context),
      ),
    );
  };

  return createMcpHandler(
    ({ era }) => {
      const server = new McpServer(
        { name: "Widefleet", version: WIDEFLEET_RUNTIME_VERSION },
        { requestState: { verify: (state, context) => codec.verify(state, context) } },
      );

      server.registerTool(
        "search",
        {
          description: "Find permitted app services. Follow cursors for more results.",
          inputSchema: {
            query: z.string().max(200).default(""),
            cursor: z.string().max(2048).optional(),
          },
          annotations: { readOnlyHint: true },
        },
        async ({ query, cursor }) =>
          result(await searchMcpServices(environment, principal, query, cursor)),
      );
      server.registerTool(
        "describe",
        {
          description: "Read the signature and documentation before calling a service.",
          inputSchema: {
            hostname: mcpServiceCall.shape.hostname,
            entrypoint: mcpServiceCall.shape.entrypoint,
          },
          annotations: { readOnlyHint: true },
        },
        async (input) => {
          return result(
            await describeMcpService(environment, principal, input.hostname, input.entrypoint),
          );
        },
      );
      server.registerTool(
        "call",
        {
          description: "Invoke a permitted app service with positional JSON arguments.",
          inputSchema: mcpServiceCall.shape,
        },
        async (service, call) => {
          if (call.mcpReq.requestState() !== undefined) return resume(call);
          const { app, value } = await invokeMcpService(environment, context, token, service);
          const reference = workflowReference.safeParse(value);

          if (!reference.success) return result(value ?? null);

          return respond(
            await present(
              {
                appId: app.appId,
                hostname: service.hostname,
                entrypoint: service.entrypoint,
                ...reference.data.workflowInstance,
              },
              call,
              era,
            ),
          );
        },
      );
      server.registerTool(
        "execute",
        {
          description:
            "Run a supported JavaScript subset in a confined interpreter. Use await tools.call({hostname,entrypoint,method,arguments}) and return JSON. No network or credentials. Limits: 32 calls, 30 seconds elapsed, 1 MiB result. Completed calls survive errors; never replay blindly.",
          inputSchema: { code: z.string().min(1).max(32768) },
        },
        async ({ code }, call) => {
          if (call.mcpReq.requestState() !== undefined) return resume(call);

          const { value, workflow } = await executeMcpCode(
            environment,
            context,
            token,
            code,
            request.signal,
          );

          return workflow ? respond(await present(workflow, call, era)) : result(value);
        },
      );

      return server;
    },
    { maxRequestBodySize: 1024 * 1024 },
  ).fetch(request);
};
