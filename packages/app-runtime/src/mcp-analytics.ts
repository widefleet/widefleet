import { waitUntil } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/server";
import { instrument } from "@posthog/mcp";
import type { BeforeSendFn } from "@posthog/mcp";
// @posthog/mcp types its client with the root entry, which resolves to the workerd build here.
import { PostHog } from "posthog-node";
import type { ParentEnvironment } from "./types.ts";

// Arguments, results and app errors of `call` and `execute` carry customer app data.
const redact: BeforeSendFn = (event) => {
  delete event.properties["$mcp_parameters"];
  delete event.properties["$mcp_response"];

  if (["call", "execute"].includes(String(event.properties["$mcp_tool_name"])))
    delete event.properties["$mcp_error_message"];

  return event;
};

/** Sends MCP usage to the installation's PostHog project, when one is configured. */
export const mcpAnalytics = (environment: ParentEnvironment, organizationId: string) => {
  const token = environment.POSTHOG_PROJECT_TOKEN;

  if (!token) return null;
  const scope = environment.POSTHOG_SCOPE ?? "installation";

  const client = new PostHog(token, {
    host: "https://eu.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 1500,
    fetchRetryCount: 0,
    // Registers each delivery with the request, so it completes after the response.
    waitUntil,
  });

  return (server: McpServer) => {
    instrument(server, client, {
      context: true,
      enableConversationId: false,
      // Failed tool calls are mostly app errors, which are not platform exceptions.
      enableExceptionAutocapture: false,
      serverBuild: WIDEFLEET_RUNTIME_VERSION,
      identify: {
        distinctId: `organization:${organizationId}`,
        groups: { organization: organizationId },
      },
      eventProperties: () => ({ scope, service: "app-runtime" }),
      beforeSend: redact,
    });
  };
};
