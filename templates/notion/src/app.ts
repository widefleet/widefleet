import { WorkerEntrypoint } from "cloudflare:workers";
import { NotionApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";
import type { NotionResult } from "./results.ts";
import { run } from "./run.ts";

type Connected<R> = Extract<Awaited<R>, { status: "connected"; data: unknown }>["data"];

type Session = Connected<ReturnType<NotionApi["getSession"]>>;

/** A session event, as `querySessionEvents` returns them. */
type SessionEvent = Connected<ReturnType<NotionApi["querySessionEvents"]>>["results"][number];

/** One server-sent event of a streamed session turn, by Notion's envelope `type`. */
export type SessionStreamEvent =
  /** The session's state when the stream starts. */
  | { type: "session.snapshot"; session: Session }
  /** Output the agent is still producing, which a later event supersedes. */
  | { type: "event.provisional"; event: SessionEvent }
  /** A durable event; its `id` is what `continue_from` replays from. */
  | { type: "event.committed"; event: SessionEvent }
  /** The stream ended while the turn still runs; continue from the last committed event. */
  | { type: "stream.timeout"; session_id: string; message: string }
  /** The turn is over; `requires_action` waits for the person's answer to a required action. */
  | { type: "stream.end"; session_id: string; status: Session["status"] }
  /** The turn failed. */
  | {
      type: "stream.error";
      session_id?: string;
      error: { code: string; message: string; retryable: boolean };
    };

/**
 * Use the current user's Notion workspace through Notion's API. Each offered
 * operation is a method. Reading never asks; methods that create, change,
 * delete or send ask the user first according to their approval level.
 *
 * @remarks
 * The connection reaches the pages and databases the person selected when
 * connecting, and their children, with the capabilities of the Notion
 * integration. A page it cannot reach answers `object_not_found`; the person
 * shares more pages by reconnecting or with **Add connections** in Notion.
 *
 * Inputs and results keep Notion's field names, in API version 2026-03-11. A
 * database holds one or more data sources: `getDatabase` lists them, and
 * `queryDataSource` and `createPage` with a `data_source_id` parent work with
 * their rows. `getPageMarkdown` and `updatePageMarkdown` read and write a
 * page's content as Notion-flavored Markdown (`markdown_version: "v2"`).
 *
 * Lists answer with `has_more` and `next_cursor`: pass `next_cursor` as
 * `start_cursor` to read the next page. `queryMeetingNotes` has no cursor; a
 * narrower `filter` or another `sort` and `limit` reach the others.
 * `getPageProperty` takes a property's `id` exactly as Notion returned it.
 *
 * `sendSessionMessage` starts or continues a Custom Agent's turn and answers
 * with the session; `streamSessionMessage` sends the same request and answers
 * with the turn's events as Notion streams them, and replays a turn from a
 * committed event's ID with `continue_from`. Files are uploaded with
 * `createFileUpload` and `sendFileUpload` (`{ mimeType, base64 }`), then
 * attached by the upload's ID. Fields that need one of Notion's betas take its
 * flag in `notionBeta`.
 *
 * A write whose answer timed out can still have been saved: its `notion_error`
 * then carries `additionalData.retry_guidance`, and the new object's ID in
 * `additionalData.committed_resource_id`.
 *
 * @example
 * ```ts
 * const found = await env.NOTION.search({
 *   body: { query: "Roadmap", filter: { property: "object", value: "page" } },
 * });
 * if (found.status === "connected") {
 *   for (const result of found.data.results) console.log(result.id, result.url);
 * }
 * ```
 */
export default class Notion extends NotionApi {
  /** Check account setup and linking. Connect the Notion account on this app's page. */
  async connectionStatus() {
    return accountConnection(this.env, this.ctx.props).status();
  }

  /**
   * Send what `sendSessionMessage` sends, and read the turn as the events
   * Notion streams until it ends, times out or fails. With `session_id` and
   * `continue_from`, a committed event's ID, the turn replays from that event.
   *
   * Asks the user first unless their approval level is `none`.
   */
  async streamSessionMessage(
    input: Parameters<NotionApi["sendSessionMessage"]>[0],
  ): Promise<NotionResult<SessionStreamEvent[]>> {
    return run(
      this.env,
      this.ctx.props,
      "sendSessionMessage",
      input,
      "events",
      "streamSessionMessage",
    );
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
    return changeApprovalLevel("Notion", this.env, this.ctx.props, input);
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
