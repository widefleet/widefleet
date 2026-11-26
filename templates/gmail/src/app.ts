import { WorkerEntrypoint } from "cloudflare:workers";
import { GmailApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Gmail account through the Gmail API. Each method of the
 * API is a method here. Reading never asks; methods that create, change, delete or
 * send ask the user first according to their approval level.
 *
 * @remarks
 * Methods that return data take the fields to return as a selection, which
 * becomes Google's `fields` parameter; the result has exactly those fields.
 * `userId` defaults to `me`.
 *
 * Methods that accept uploads also have a `...WithContent` method, such as
 * `messagesSendWithContent`, which takes the message as MIME in `content`: `{
 * mimeType: "message/rfc822", text }`, or `base64` for bytes. Treat email HTML
 * as untrusted content.
 *
 * @example
 * ```ts
 * const page = await env.GMAIL.messagesList(
 *   { q: "has:attachment newer_than:7d", maxResults: 10 },
 *   { messages: { id: true }, nextPageToken: true },
 * );
 * if (page.status === "connected") {
 *   for (const { id } of page.data.messages ?? []) {
 *     const message = await env.GMAIL.messagesGet(
 *       { id: id ?? "", format: "metadata", metadataHeaders: ["Subject", "From"] },
 *       { snippet: true, payload: { headers: { name: true, value: true } } },
 *     );
 *   }
 * }
 * ```
 */
export default class Gmail extends GmailApi {
  /** Check account setup and linking. Connect the Gmail account on this app's page. */
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
    return changeApprovalLevel("Gmail", this.env, this.ctx.props, input);
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
