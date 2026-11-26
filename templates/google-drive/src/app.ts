import { WorkerEntrypoint } from "cloudflare:workers";
import { GoogleDriveApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Google Drive account through the Google Drive API. Each method of the
 * API is a method here. Reading never asks; methods that create, change, delete or
 * send ask the user first according to their approval level.
 *
 * @remarks
 * Methods that return data take the fields to return as a selection, which
 * becomes Google's `fields` parameter; the result has exactly those fields.
 *
 * `filesGetContent` and `revisionsGetContent` return a file's content with its
 * `contentType`, as `text` for text types and as `base64` otherwise, up to 8
 * MiB (1 MiB through MCP). `filesExport` converts a Google Docs, Sheets or
 * Slides file to another type, such as `application/pdf`.
 *
 * `filesCreateWithContent` and `filesUpdateWithContent` upload a file's
 * metadata and content together. The content has its `mimeType` and either
 * `text`, sent as UTF-8, or `base64` for any other bytes.
 *
 * @example
 * ```ts
 * const found = await env.DRIVE.filesList(
 *   { q: "name contains 'budget' and trashed = false", pageSize: 10 },
 *   { files: { id: true, name: true, mimeType: true } },
 * );
 * if (found.status === "connected") {
 *   for (const file of found.data.files ?? []) console.log(file.name, file.mimeType);
 * }
 * ```
 */
export default class GoogleDrive extends GoogleDriveApi {
  /** Check account setup and linking. Connect the Google Drive account on this app's page. */
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
    return changeApprovalLevel("Google Drive", this.env, this.ctx.props, input);
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
