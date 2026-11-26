import { WorkerEntrypoint } from "cloudflare:workers";
import { OneDriveApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's OneDrive through Microsoft Graph. Each offered Graph
 * operation is a method. Reading never asks; methods that create, change, delete
 * or share ask the user first according to their approval level.
 *
 * @remarks
 * Items are addressed by their drive and item IDs: `myDrive` returns the user's
 * drive, and `root` names its top folder.
 *
 * Graph's query options keep their names, such as `$select`, `$top`, `$filter`
 * and `$orderby`. A list with more items carries `@odata.nextLink`: pass it as
 * `nextLink` to the same method to read the next page. `delta` answers with
 * `@odata.deltaLink`, which `nextLink` also takes to read later changes.
 *
 * `getContent` and `getVersionContent` return a temporary `downloadUrl` that
 * grants file access: open it in the browser and keep it out of logs.
 * `replaceContent` uploads text up to 250 MB; for larger or binary files,
 * `createUploadSession` returns an upload address.
 *
 * @example
 * ```ts
 * const drive = await env.ONEDRIVE.myDrive();
 * if (drive.status === "connected" && drive.data.id) {
 *   const files = await env.ONEDRIVE.listChildren({
 *     driveId: drive.data.id,
 *     driveItemId: "root",
 *     $top: 50,
 *     $select: ["id", "name", "size", "file", "folder"],
 *   });
 *   if (files.status === "connected") {
 *     for (const item of files.data.value ?? []) console.log(item.name, item.size);
 *   }
 * }
 * ```
 */
export default class OneDrive extends OneDriveApi {
  /** Check account setup and linking. Connect the OneDrive account on this app's page. */
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
    return changeApprovalLevel("OneDrive", this.env, this.ctx.props, input);
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
