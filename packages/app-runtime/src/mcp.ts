import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { mcpServiceCall, mcpScopes } from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { verifyMcpToken } from "./mcp-authorization.ts";
import { readMcpConfiguration } from "./mcp-oauth.ts";
import { callMcpService, describeMcpService, searchMcpServices } from "./mcp-services.ts";
import { executeMcpCode, mcpJson } from "./mcp-code.ts";
import { mcpInstructions, mcpSkillCatalog } from "./mcp-skills.ts";

const resultSchema = mcpJson.transform((value) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
}));

const result = resultSchema.parse.bind(resultSchema);

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
  const catalog = skills();
  const extension = await catalog.extension();

  return createMcpHandler(
    () => {
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
        async (service) =>
          result((await callMcpService(environment, context, token, service)) ?? null),
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

      return server;
    },
    { maxRequestBodySize: 1024 * 1024 },
  ).fetch(request);
};
