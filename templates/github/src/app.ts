import { WorkerEntrypoint } from "cloudflare:workers";
import { GitHubApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's GitHub account through GitHub's GraphQL API. Each
 * query and mutation is a method. Queries read without asking; mutations ask the
 * user first according to their approval level.
 *
 * @remarks
 * Methods that return objects take the fields to return. `$args` passes a
 * field's arguments, such as `{ comments: { $args: { first: 5 }, nodes: { body:
 * true } } }`, and `$on` selects fields per type, with `__typename` in the
 * result.
 *
 * Most data is reached through `repository`, `viewer`, `organization`, `user`,
 * `node` and `search`. File contents are `Blob` objects: `repository.object`
 * with `$args: { expression: "main:README.md" }` and `$on: { Blob: { text: true
 * } }` reads a text file.
 *
 * @example
 * ```ts
 * const result = await env.GITHUB.repository(
 *   { owner: "example", name: "project" },
 *   {
 *     issues: {
 *       $args: { first: 10, states: ["OPEN"] },
 *       nodes: { number: true, title: true, author: { login: true } },
 *     },
 *   },
 * );
 * if (result.status === "connected" && result.data) {
 *   for (const issue of result.data.issues.nodes ?? []) console.log(issue?.number, issue?.title);
 * }
 * ```
 */
export default class GitHub extends GitHubApi {
  /** Check account setup and linking. Connect the GitHub account on this app's page. */
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
    return changeApprovalLevel("GitHub", this.env, this.ctx.props, input);
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
