import type { ApprovalQuestion } from "./approval.ts";

/**
 * Why a call could not use the user's Microsoft account or environment.
 * `connectUrl` lets the user fix it. `network_required` names the origin an
 * administrator allows with `widefleet network allow`.
 */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "setup_required"; missing: string[]; connectUrl: string }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "permission_required"; connectUrl: string }
  | { status: "network_required"; origin: string }
  | { status: "refresh_failed" }
  | { status: "rate_limited"; retryAfter: string | null };

/** An error Dataverse reported for a request, such as an unknown row or missing privilege. */
export interface DataverseError {
  /** Dataverse's error code, a hexadecimal number such as `0x80040217` for a row that does not exist. */
  code: string;
  message: string;
  /** The HTTP status Dataverse answered with. */
  status: number;
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a Dataverse method: the data, a question, or why there is no data. */
export type DataverseResult<T> =
  | ApprovalQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "dataverse_error"; error: DataverseError }
      | { status: "declined" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
