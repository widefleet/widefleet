import { WorkerEntrypoint } from "cloudflare:workers";
import { ExcelApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Excel workbooks in OneDrive and SharePoint through
 * Microsoft Graph. Each offered Graph operation is a method. Reading never asks;
 * methods that create, change or delete ask the user first according to their
 * approval level.
 *
 * @remarks
 * A workbook is addressed by its drive and item IDs: `myDrive` returns the
 * user's drive and `search` finds workbooks in it. Worksheets, tables and names
 * are addressed by ID or name.
 *
 * `getRange`, `usedRange` and `getNamedRange` return `values`, `formulas`,
 * `text` and `numberFormat` as one list of cells per row. `updateRange` writes
 * them the same way and leaves `null` cells unchanged. Whole columns or rows,
 * such as `C:C`, read as `null`: use `usedRange` or a bounded address.
 *
 * Graph's query options keep their names, such as `$select`, `$top`, `$filter`
 * and `$orderby`. A list with more items carries `@odata.nextLink`: pass it as
 * `nextLink` to the same method to read the next page.
 *
 * For a series of calls, `createSession` with `{ persistChanges: true }`
 * returns a session whose `data.id`, passed as `sessionId` to later calls,
 * makes them faster. With `persistChanges: false`,
 * changes stay in a temporary copy. Sessions end after a few minutes without
 * calls; `refreshSession` keeps one open, and a call in an ended session
 * returns `graph_error` with status 404.
 *
 * @example
 * ```ts
 * const drive = await env.EXCEL.myDrive();
 * const found =
 *   drive.status === "connected" && drive.data.id
 *     ? await env.EXCEL.search({ driveId: drive.data.id, q: "Budget.xlsx" })
 *     : null;
 * const workbook = found?.status === "connected" ? found.data.value?.[0] : undefined;
 *
 * if (drive.status === "connected" && drive.data.id && workbook?.id) {
 *   const at = { driveId: drive.data.id, driveItemId: workbook.id, workbookWorksheetId: "Sheet1" };
 *   const range = await env.EXCEL.getRange({ ...at, address: "A1:C10" });
 *   if (range.status === "connected") console.log(range.data?.values);
 *
 *   await env.EXCEL.updateRange({
 *     ...at,
 *     address: "D2:D3",
 *     body: { formulas: [["=SUM(A2:C2)"], ["=SUM(A3:C3)"]] },
 *   });
 * }
 * ```
 */
export default class Excel extends ExcelApi {
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
    return changeApprovalLevel("Excel", this.env, this.ctx.props, input);
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
