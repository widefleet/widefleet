import type { ApprovalQuestion } from "./approval.ts";
import type { JsonValue } from "./selection.ts";

/** Why a call could not use the user's Notion account. `connectUrl` lets the user fix it. */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "setup_required"; missing: string[]; connectUrl: string }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "refresh_failed" }
  | { status: "rate_limited"; retryAfter: string | null };

/** An error Notion reported for a request, such as a page not shared with the connection. */
export interface NotionError {
  /** The HTTP status Notion answered with. */
  status: number;
  /** Notion's error code, such as `object_not_found`, `validation_error` or `restricted_resource`. */
  code: string;
  message: string;
  /** The ID Notion's support asks for. */
  requestId: string | null;
  /**
   * Notion's details, such as `retry_guidance` and `committed_resource_id`
   * for a write that was saved although its answer timed out.
   */
  additionalData: Record<string, JsonValue> | null;
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a Notion method: the data, a question, or why there is no data. */
export type NotionResult<T> =
  | ApprovalQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "notion_error"; error: NotionError }
      | { status: "declined" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
