import type { ApprovalQuestion } from "./approval.ts";
import type { JsonValue } from "./selection.ts";

/** Why a call could not use the user's WHOOP account. `connectUrl` lets the user fix it. */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "setup_required"; missing: string[]; connectUrl: string }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "permission_required"; connectUrl: string }
  | { status: "refresh_failed" }
  | { status: "rate_limited"; retryAfter: string | null };

/**
 * An error WHOOP reported for a request, such as an unknown cycle or invalid
 * input. WHOOP's description names no error body, so `body` is the JSON it sent,
 * if any.
 */
export interface WhoopError {
  /** The HTTP status WHOOP answered with, such as 400 or 404. */
  status: number;
  body: JsonValue | null;
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a WHOOP method: the data, a question, or why there is no data. */
export type WhoopResult<T> =
  | ApprovalQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "whoop_error"; error: WhoopError }
      | { status: "declined" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
