import { WorkerEntrypoint } from "cloudflare:workers";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";
import { z } from "zod";
import {
  issue,
  issueDetails,
  issueFields,
  issueInput,
  issuesInput,
  nextPage,
  team,
  teamsInput,
} from "./linear.ts";

/** Read teams and issues accessible to the current user's Linear connection. */
export default class Linear extends WorkerEntrypoint<Environment, Properties> {
  #connection() {
    return accountConnection(this.env, this.ctx.props);
  }

  /** Check account setup and linking. Connect the Linear account on this app's page. */
  async connectionStatus() {
    return this.#connection().status();
  }

  /** List teams in the connected workspace. Pass cursor to continue. */
  async listTeams(input: z.input<typeof teamsInput> = {}) {
    const result = await this.#connection().call("list_teams", teamsInput.parse(input));

    if (result.status !== "connected") return result;

    const output = z
      .object({ teams: z.array(team) })
      .extend(nextPage.shape)
      .parse(result.output);

    return {
      status: "connected",
      teams: output.teams,
      cursor: output.hasNextPage ? (output.cursor ?? null) : null,
    } as const;
  }

  /**
   * List issues, most recently updated first. team, state and assignee take a
   * name or ID; assignee also takes "me". Pass cursor to continue.
   * @example
   * ```ts
   * await env.LINEAR.listIssues({ assignee: "me", state: "started" });
   * ```
   */
  async listIssues(input: z.input<typeof issuesInput> = {}) {
    const result = await this.#connection().call("list_issues", {
      ...issuesInput.parse(input),
      fields: issueFields,
    });

    if (result.status !== "connected") return result;

    const output = z
      .object({ issues: z.array(issue) })
      .extend(nextPage.shape)
      .parse(result.output);

    return {
      status: "connected",
      issues: output.issues,
      cursor: output.hasNextPage ? (output.cursor ?? null) : null,
    } as const;
  }

  /** Read one issue with its description. id is an identifier such as ENG-123 or the issue ID. */
  async getIssue(input: z.input<typeof issueInput>) {
    const result = await this.#connection().call("get_issue", {
      ...issueInput.parse(input),
      fields: [...issueFields, "description"],
    });

    if (result.status !== "connected") return result;

    return { status: "connected", issue: issueDetails.parse(result.output) } as const;
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
