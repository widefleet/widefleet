import { WorkerEntrypoint } from "cloudflare:workers";
import { GoogleSheetsApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Google Sheets account through the Google Sheets API. Each method of the
 * API is a method here. Reading never asks; methods that create, change, delete or
 * send ask the user first according to their approval level.
 *
 * @remarks
 * Methods that return data take the fields to return as a selection, which
 * becomes Google's `fields` parameter; the result has exactly those fields.
 * Ranges use A1 notation, such as `Expenses!A2:C`. Select few fields from
 * `get`: a spreadsheet with `includeGridData` can be large.
 *
 * @example
 * ```ts
 * const range = await env.SHEETS.valuesGet(
 *   {
 *     spreadsheetId: "SPREADSHEET-ID",
 *     range: "Expenses!A2:C",
 *     valueRenderOption: "UNFORMATTED_VALUE",
 *   },
 *   { values: true },
 * );
 * if (range.status === "connected") {
 *   for (const [date, item, amount] of range.data.values ?? []) console.log(date, item, amount);
 * }
 * ```
 */
export default class GoogleSheets extends GoogleSheetsApi {
  /** Check account setup and linking. Connect the Google Sheets account on this app's page. */
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
    return changeApprovalLevel("Google Sheets", this.env, this.ctx.props, input);
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
