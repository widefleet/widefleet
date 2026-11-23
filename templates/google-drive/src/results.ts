import type { ApprovalQuestion } from "./approval.ts";

/** Why a call could not use the user's Google account. `connectUrl` lets the user fix it. */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "setup_required"; missing: string[]; connectUrl: string }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "permission_required"; connectUrl: string }
  | { status: "refresh_failed" }
  | { status: "rate_limited"; retryAfter: string | null };

/** An error Google Drive reported for a request, such as an unknown file or invalid input. */
export interface DriveError {
  message: string;
  /** The HTTP status Google Drive answered with. */
  code: number;
  /** Google's status, such as `NOT_FOUND` or `INVALID_ARGUMENT`. */
  status: string | null;
  /** Google's reasons, such as `notFound` or `insufficientFilePermissions`. */
  reasons: string[];
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a Google Drive method: the selected data, a question, or why there is no data. */
export type GoogleDriveResult<T> =
  | ApprovalQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "drive_error"; error: DriveError }
      | { status: "declined" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
