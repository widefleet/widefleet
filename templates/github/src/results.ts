import type { ApprovalQuestion } from "./approval.ts";

/** Why a call could not use the user's GitHub account. `connectUrl` lets the user fix it. */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "setup_required"; missing: string[]; connectUrl: string }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "permission_required"; connectUrl: string }
  | { status: "refresh_failed" }
  | { status: "rate_limited"; retryAfter: string | null }
  | { status: "access_denied" };

/** An error GitHub reported for a request, such as an unknown repository or invalid input. */
export interface GitHubError {
  message: string;
  /** GitHub's error type, such as `NOT_FOUND`, `FORBIDDEN` or `INSUFFICIENT_SCOPES`. */
  type: string | null;
  /** The fields of the request the error belongs to. */
  path: (string | number)[] | null;
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a GitHub method: the selected data, a question, or why there is no data. */
export type GitHubResult<T> =
  | ApprovalQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "github_error"; errors: GitHubError[] }
      | { status: "declined" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
