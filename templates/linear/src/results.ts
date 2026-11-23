import type { ApprovalQuestion } from "./approval.ts";

/** Why a call could not use the user's Linear account. `connectUrl` lets the user fix it. */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "setup_required"; missing: string[]; connectUrl: string }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "refresh_failed" }
  | { status: "rate_limited"; retryAfter: string | null }
  | { status: "access_denied" };

/** An error Linear reported for a request, such as an unknown issue or invalid input. */
export interface LinearError {
  message: string;
  /** Linear's error type, such as `invalid input` or `forbidden`. */
  type: string | null;
  /** The fields of the request the error belongs to. */
  path: (string | number)[] | null;
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a Linear method: the selected data, a question, or why there is no data. */
export type LinearResult<T> =
  | ApprovalQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "linear_error"; errors: LinearError[] }
      | { status: "declined" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
