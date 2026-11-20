import {
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  inputRequired,
  McpServer,
} from "@modelcontextprotocol/server";
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { inputAnswer, mcpServiceCall, mcpScopes, sealedInputRequired } from "@platform/contracts";
import { inputFormHtml } from "#mcp-input-form";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { mcpAnalytics } from "./mcp-analytics.ts";
import { verifyMcpToken } from "./mcp-authorization.ts";
import { readMcpConfiguration } from "./mcp-oauth.ts";
import {
  callMcpService,
  describeMcpService,
  formMcpInput,
  searchMcpServices,
} from "./mcp-services.ts";
import { inputFormMeta, inputFormUri } from "./mcp-input-form.ts";
import { executeMcpCode, mcpJson } from "./mcp-code.ts";
import { createMcpCliLogin } from "./mcp-cli-login.ts";
import { mcpInstructions, mcpSkillCatalog } from "./mcp-skills.ts";

const resultSchema = mcpJson.transform((value) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
}));

const result = resultSchema.parse.bind(resultSchema);

const envelope = z
  .looseObject({
    [CLIENT_CAPABILITIES_META_KEY]: z
      .looseObject({
        elicitation: z.looseObject({ form: z.unknown(), url: z.unknown() }).partial().optional(),
        extensions: z.record(z.string(), z.unknown()).optional(),
      })
      .catch({}),
  })
  .catch({ [CLIENT_CAPABILITIES_META_KEY]: {} });

const formInput = mcpServiceCall.extend({
  requestState: sealedInputRequired.shape.requestState,
});

let skillCatalog: ReturnType<typeof mcpSkillCatalog> | undefined;

// The build embeds the plugin's skill so the plugin and the MCP server serve the same file.
const skills = () => (skillCatalog ??= mcpSkillCatalog({ widefleet: WIDEFLEET_SKILL_SOURCE }));

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
  const instrumentAnalytics = mcpAnalytics(environment, principal.mcp.organizationId);
  const catalog = skills();
  const extension = await catalog.extension();

  return createMcpHandler(
    ({ era }) => {
      const server = new McpServer(
        { name: "Widefleet", version: WIDEFLEET_RUNTIME_VERSION },
        { instructions: mcpInstructions },
      );

      extension.attach(server);
      server.registerTool(
        "skills",
        {
          description:
            "List Widefleet skills, or read one by name. Skills are instructions for working with Widefleet, such as building and deploying apps.",
          inputSchema: { name: z.string().min(1).max(64).optional() },
          annotations: { readOnlyHint: true },
        },
        async ({ name }) => result(await catalog.read(name)),
      );
      server.registerTool(
        "search",
        {
          description:
            "Find permitted app services by words in their hostnames, entrypoints and documentation. Returns the best matches first. Pass an exact hostname to list its entrypoints, or omit query to list every service. To read the following page, call search again with the returned next object as the whole input; next is null on the last page. complete is false while the service list is being rebuilt; search again to include the remaining services.",
          inputSchema: {
            query: z
              .string()
              .max(200)
              .default("")
              .describe("Words matched against hostnames, entrypoints and documentation."),
            limit: z
              .number()
              .int()
              .min(1)
              .max(50)
              .default(10)
              .describe("Most services to return, 10 by default."),
            offset: z.number().int().min(0).default(0),
          },
          annotations: { readOnlyHint: true },
        },
        async (input) => result(await searchMcpServices(environment, principal, input)),
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
          // A retry of a call that asked for input carries the sealed state and the answers.
          const state = call.mcpReq.requestState();

          const answer =
            state === undefined
              ? undefined
              : inputAnswer.parse({
                  inputResponses: call.mcpReq.inputResponses ?? {},
                  requestState: state,
                });

          const value = await callMcpService(environment, context, token, service, answer);
          const question = sealedInputRequired.safeParse(value);

          if (!question.success) return result(value ?? null);

          // 2026 clients declare capabilities per request. Stateless 2025-era serving
          // sees none and has no way back to the client for a dialog.
          const declared =
            era === "modern"
              ? envelope.parse(call.mcpReq.envelope)[CLIENT_CAPABILITIES_META_KEY]
              : undefined;

          // An empty elicitation capability means form elicitation.
          const elicitation = declared?.elicitation;

          if (elicitation && (elicitation.form !== undefined || elicitation.url === undefined))
            return inputRequired({
              inputRequests: Object.fromEntries(
                Object.entries(question.data.inputRequests).map(([name, request]) => [
                  name,
                  inputRequired.elicit(request),
                ]),
              ),
              requestState: question.data.requestState,
            });

          // 2025-era clients get the form unchecked: some render MCP Apps without
          // declaring them on any request the gateway sees.
          if (declared && declared.extensions?.[EXTENSION_ID] === undefined)
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "This method asks the user for input, and this MCP client can show neither input dialogs nor MCP Apps forms.",
                },
              ],
            };

          return {
            content: [
              {
                type: "text" as const,
                text: `This method asks the user for input. Call the ask tool with the same hostname, entrypoint, method and arguments, and requestState ${JSON.stringify(question.data.requestState)}. It shows the user a form; their answer completes this call. Do not answer it yourself. If no form appears, this MCP client cannot show it.`,
              },
            ],
          };
        },
      );
      registerAppResource(
        server,
        "input-form",
        inputFormUri,
        { description: "Form for questions from app services" },
        async () => ({
          contents: [{ uri: inputFormUri, mimeType: RESOURCE_MIME_TYPE, text: inputFormHtml }],
        }),
      );
      registerAppTool(
        server,
        "ask",
        {
          description:
            "Show the user a form for a service call that asks for input. Use it only when call says so; the user's answer completes the call.",
          inputSchema: formInput,
          _meta: { ui: { resourceUri: inputFormUri } },
        },
        async ({ requestState, ...service }) => {
          const question = await formMcpInput(environment, token, service, requestState);

          return {
            content: [
              {
                type: "text" as const,
                text: "The form is shown to the user. Wait for their answer.",
              },
            ],
            _meta: inputFormMeta({
              call: service,
              inputRequests: question.inputRequests,
              requestState: question.requestState,
            }),
          };
        },
      );
      registerAppTool(
        server,
        "answer",
        {
          description: "Submit the user's answer from the input form. Only the form calls it.",
          inputSchema: formInput.extend({ inputResponses: inputAnswer.shape.inputResponses }),
          _meta: { ui: { resourceUri: inputFormUri, visibility: ["app"] } },
        },
        async ({ requestState, inputResponses, ...service }) => {
          const value = await callMcpService(
            environment,
            context,
            token,
            service,
            { requestState, inputResponses },
            "form",
          );

          const question = sealedInputRequired.safeParse(value);

          // A follow-up question stays in the form.
          if (question.success)
            return {
              content: [{ type: "text" as const, text: "The method asks the user again." }],
              _meta: inputFormMeta({
                call: service,
                inputRequests: question.data.inputRequests,
                requestState: question.data.requestState,
              }),
            };

          return result(value ?? null);
        },
      );
      server.registerTool(
        "execute",
        {
          description:
            "Run a supported JavaScript subset in a confined interpreter. Use await tools.call({hostname,entrypoint,method,arguments}) and return JSON. No network or credentials. Limits: 32 calls, 30 seconds elapsed, 1 MiB result. Completed calls survive errors; never replay blindly.",
          inputSchema: { code: z.string().min(1).max(32768) },
        },
        async ({ code }) =>
          result(await executeMcpCode(environment, context, token, code, request.signal)),
      );
      server.registerTool(
        "cli_login",
        {
          description:
            "Sign in the Widefleet CLI as the current user. Use it when the CLI reports that no session is stored, for example in a new sandbox. Returns a shell command with a one-time code that expires after two minutes.",
          inputSchema: {},
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async () => result(await createMcpCliLogin(environment, token)),
      );

      instrumentAnalytics?.(server);

      return server;
    },
    { maxRequestBodySize: 1024 * 1024 },
  ).fetch(request);
};
