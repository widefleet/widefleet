import { WorkerEntrypoint } from "cloudflare:workers";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";
import type { z } from "zod";
import { callTool, listTools, tool, toolCallInput, toolOutput } from "./linear.ts";

// Linear lists its tools on one page today; the bound keeps a misbehaving
// server from paging forever.
const maxToolPages = 20;

/** Use the current user's Linear workspace through every tool of Linear's MCP server. */
export default class Linear extends WorkerEntrypoint<Environment, Properties> {
  #connection() {
    return accountConnection(this.env, this.ctx.props);
  }

  /** Check account setup and linking. Connect the Linear account on this app's page. */
  async connectionStatus() {
    return this.#connection().status();
  }

  /**
   * List Linear's tools with their input schemas, as JSON Schema text, and hints. `readOnlyHint`
   * marks tools that only read; `destructiveHint` marks tools that can delete
   * or overwrite data.
   */
  async listTools() {
    const tools: z.output<typeof tool>[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxToolPages; page++) {
      const response = await this.#connection().rpc(listTools(cursor));

      if (response.status !== "connected") return response;
      tools.push(...response.result.tools);
      cursor = response.result.nextCursor;

      if (!cursor) return { status: "connected", tools } as const;
    }

    throw new Error("Linear's tool list did not end");
  }

  /**
   * Call a Linear tool by name with arguments that match its input schema from
   * listTools. `text` holds the tool's JSON result.
   * @example
   * ```ts
   * const result = await env.LINEAR.callTool({ name: "list_issues", arguments: { assignee: "me" } });
   * if (result.status === "connected") console.log(JSON.parse(result.text));
   * ```
   */
  async callTool(input: z.input<typeof toolCallInput>) {
    const response = await this.#connection().rpc(callTool(toolCallInput.parse(input)));

    if (response.status !== "connected") return response;

    return toolOutput(response.result);
  }

  override async fetch(request: Request) {
    return this.#connection().fetch(request);
  }
}

/** Personal account controls used by Widefleet's My connections page. */
export class UserConnection extends WorkerEntrypoint<Environment, Properties> {
  async status() {
    return accountConnection(this.env, this.ctx.props).personalStatus();
  }

  async prepare(input: { completionUrl: string }) {
    return accountConnection(this.env, this.ctx.props).prepare(input);
  }

  async disconnect() {
    return accountConnection(this.env, this.ctx.props).disconnect();
  }
}
