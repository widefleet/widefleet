import { WorkerEntrypoint } from "cloudflare:workers";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";
import { LinearTools } from "./tools.ts";

/**
 * Use the current user's Linear workspace. Every tool of Linear's MCP server is
 * a method; tools that can delete or overwrite data ask the user first.
 */
export default class Linear extends LinearTools {
  /** Check account setup and linking. Connect the Linear account on this app's page. */
  async connectionStatus() {
    return accountConnection(this.env, this.ctx.props).status();
  }

  override async fetch(request: Request) {
    return accountConnection(this.env, this.ctx.props).fetch(request);
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
