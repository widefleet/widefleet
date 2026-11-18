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
  });

  return {
    instrument(server: McpServer) {
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
    },

    // Tool calls can finish while a streamed response is still open, so deliver after it ends.
    deliver(response: Response) {
      const flush = () => client.shutdown(1500).catch(() => undefined);

      if (!response.body) {
        waitUntil(flush());

        return response;
      }

      const { readable, writable } = new TransformStream();
      waitUntil(response.body.pipeTo(writable).then(flush, flush));

      return new Response(readable, response);
    },
  };
};
