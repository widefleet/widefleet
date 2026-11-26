import { WorkerEntrypoint } from "cloudflare:workers";
import { GoogleCalendarApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Google Calendar account through the Google Calendar API. Each method of the
 * API is a method here. Reading never asks; methods that create, change, delete or
 * send ask the user first according to their approval level.
 *
 * @remarks
 * Methods that return data take the fields to return as a selection, which
 * becomes Google's `fields` parameter; the result has exactly those fields.
 * `primary` names the user's own calendar.
 *
 * @example
 * ```ts
 * const week = await env.CALENDAR.eventsList(
 *   {
 *     calendarId: "primary",
 *     timeMin: "2026-12-01T00:00:00Z",
 *     timeMax: "2026-12-08T00:00:00Z",
 *     singleEvents: true,
 *     orderBy: "startTime",
 *   },
 *   { items: { id: true, summary: true, start: { dateTime: true, date: true } } },
 * );
 * if (week.status === "connected") {
 *   for (const event of week.data.items ?? []) console.log(event.summary, event.start?.dateTime);
 * }
 * ```
 */
export default class GoogleCalendar extends GoogleCalendarApi {
  /** Check account setup and linking. Connect the Google Calendar account on this app's page. */
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
    return changeApprovalLevel("Google Calendar", this.env, this.ctx.props, input);
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
