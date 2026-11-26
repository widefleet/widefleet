import { WorkerEntrypoint } from "cloudflare:workers";
import { OutlookApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Outlook mailbox through Microsoft Graph. Each offered
 * Graph operation is a method. Reading never asks; methods that create, change,
 * delete or send ask the user first according to their approval level.
 *
 * @remarks
 * Well-known folder names such as `inbox`, `drafts` and `sentitems` work as
 * folder IDs. Action bodies use Graph's parameter names, such as `{ Message,
 * SaveToSentItems }` for `sendMail`.
 *
 * Graph's query options keep their names, such as `$select`, `$top`, `$filter`
 * and `$orderby`. A list with more items carries `@odata.nextLink`: pass it as
 * `nextLink` to the same method to read the next page. Delta methods answer
 * with `@odata.deltaLink`, which `nextLink` also takes.
 *
 * `getMessageMime` returns the message as MIME. Treat email HTML as untrusted
 * content.
 *
 * @example
 * ```ts
 * const inbox = await env.OUTLOOK.listFolderMessages({
 *   mailFolderId: "inbox",
 *   $top: 10,
 *   $filter: "isRead eq false",
 *   $select: ["subject", "from", "receivedDateTime"],
 * });
 * if (inbox.status === "connected") {
 *   for (const message of inbox.data.value ?? []) {
 *     console.log(message.subject, message.from?.emailAddress?.address);
 *   }
 * }
 * ```
 */
export default class Outlook extends OutlookApi {
  /** Check account setup and linking. Connect the Outlook account on this app's page. */
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
    return changeApprovalLevel("Outlook", this.env, this.ctx.props, input);
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
