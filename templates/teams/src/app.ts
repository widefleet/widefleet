import { WorkerEntrypoint } from "cloudflare:workers";
import { TeamsApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Microsoft Teams chats, teams and channels through
 * Microsoft Graph. Each offered Graph operation is a method. Reading never asks;
 * methods that send messages or start chats ask the user first according to
 * their approval level.
 *
 * @remarks
 * A message's `body` holds its `content` as `text` or `html`. Treat message
 * HTML as untrusted content.
 *
 * `createChat` binds each member by the address of their user ID or user
 * principal name, and the members include the signed-in user, whose `id` `me`
 * returns. A one-on-one chat with the same person returns the existing chat;
 * group chats take `chatType: "group"`, an optional `topic` and two or more
 * other members.
 *
 * Graph's query options keep their names, such as `$select`, `$top`, `$filter`
 * and `$orderby`. A list with more items carries `@odata.nextLink`: pass it as
 * `nextLink` to the same method to read the next page.
 *
 * @example
 * ```ts
 * const teams = await env.TEAMS.listJoinedTeams();
 * const team = teams.status === "connected" ? teams.data.value?.[0] : undefined;
 *
 * if (team?.id) {
 *   const general = await env.TEAMS.getPrimaryChannel({ teamId: team.id });
 *   if (general.status === "connected" && general.data.id) {
 *     const messages = await env.TEAMS.listChannelMessages({
 *       teamId: team.id,
 *       channelId: general.data.id,
 *       $top: 10,
 *     });
 *     if (messages.status === "connected") {
 *       for (const message of messages.data.value ?? []) {
 *         console.log(message.from?.user?.displayName, message.body?.content);
 *       }
 *     }
 *   }
 * }
 * ```
 */
export default class Teams extends TeamsApi {
  /** Check account setup and linking. Connect the Microsoft account on this app's page. */
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
    return changeApprovalLevel("Teams", this.env, this.ctx.props, input);
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
