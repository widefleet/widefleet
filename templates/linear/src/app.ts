import { WorkerEntrypoint } from "cloudflare:workers";
import { LinearApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Linear workspace through Linear's GraphQL API. Each
 * query and mutation is a method. Queries read without asking; mutations ask the
 * user first according to their approval level.
 *
 * @remarks
 * Methods that return objects take the fields to return. `$args` passes a
 * field's arguments, such as `{ comments: { $args: { first: 5 }, nodes: { body:
 * true } } }`, and `$on` selects fields per type, with `__typename` in the
 * result.
 *
 * The queries `initiativeUpdate` and `projectUpdate`, which read one status
 * update, are `initiativeUpdateById` and `projectUpdateById`; the mutations of
 * the same name update an initiative or project.
 *
 * @example
 * ```ts
 * const result = await env.LINEAR.issues(
 *   { first: 10, filter: { assignee: { isMe: { eq: true } } } },
 *   { nodes: { identifier: true, title: true, state: { name: true } } },
 * );
 * if (result.status === "connected") {
 *   for (const issue of result.data.nodes) console.log(issue.identifier, issue.state.name);
 * }
 * ```
 */
export default class Linear extends LinearApi {
  /** Check account setup and linking. Connect the Linear account on this app's page. */
  async connectionStatus() {
    return accountConnection(this.env, this.ctx.props).status();
  }

  /** The current user's approval level, which decides when changes ask first. */
  async approvalLevel() {
    return readApprovalLevel(this.env, this.ctx.props);
  }

  /**
   * Set when the current user is asked before changes run. Asking more takes
   * effect at once; asking less asks the user to confirm.
   */
  async setApprovalLevel(input: { level: ApprovalLevel }) {
    return changeApprovalLevel("Linear", this.env, this.ctx.props, input);
  }

  override async fetch(request: Request) {
    return (
      (await saveApprovalLevel(this.env, this.ctx.props, request)) ??
      accountConnection(this.env, this.ctx.props).fetch(request)
    );
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
