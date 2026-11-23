import type { ApprovalQuestion } from "./approval.ts";

/** Why a call could not use the user's Strava account. `connectUrl` lets the user fix it. */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "setup_required"; missing: string[]; connectUrl: string }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "permission_required"; connectUrl: string }
  | { status: "refresh_failed" }
  | { status: "rate_limited"; retryAfter: string | null };

/** An error Strava reported for a request, such as an unknown record or invalid input. */
export interface StravaError {
  message: string;
  /** What failed, such as `{ resource: "Activity", field: "id", code: "invalid" }`. */
  errors: {
    resource?: string | undefined;
    field?: string | undefined;
    code?: string | undefined;
  }[];
  /** The HTTP status Strava answered with. */
  status: number;
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a Strava method: the data, a question, or why there is no data. */
export type StravaResult<T> =
  | ApprovalQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "strava_error"; error: StravaError }
      | { status: "declined" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
