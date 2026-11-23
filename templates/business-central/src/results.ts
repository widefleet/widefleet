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

/** An error Business Central reported for a request, such as an unknown entity or invalid input. */
export interface BusinessCentralError {
  /**
   * Business Central's error code, such as `BadRequest_NotFound`,
   * `Request_EntityChanged` or `Internal_ValidationError`.
   */
  code: string;
  message: string;
  /** The HTTP status Business Central answered with. */
  status: number;
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a Business Central method: the data, a question, or why there is no data. */
export type BusinessCentralResult<T> =
  | ApprovalQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "business_central_error"; error: BusinessCentralError }
      | { status: "declined" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
