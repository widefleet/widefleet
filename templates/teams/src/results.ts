import type { ApprovalQuestion } from "./approval.ts";

/** Why a call could not use the user's Microsoft account. `connectUrl` lets the user fix it. */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "setup_required"; missing: string[]; connectUrl: string }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "permission_required"; connectUrl: string }
  | { status: "refresh_failed" }
  | { status: "rate_limited"; retryAfter: string | null };

/** An error Microsoft Graph reported for a request, such as an unknown item or invalid input. */
export interface GraphError {
  /** Graph's error code, such as `NotFound`, `Forbidden` or `BadRequest`. */
  code: string;
  message: string;
  /** The HTTP status Graph answered with. */
  status: number;
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a Teams method: the data, a question, or why there is no data. */
export type TeamsResult<T> =
  | ApprovalQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "graph_error"; error: GraphError }
      | { status: "declined" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
