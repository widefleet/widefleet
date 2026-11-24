import type { ApprovalQuestion } from "./approval.ts";

/** Why a call could not use the user's Qonto account. `connectUrl` lets the user fix it. */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "setup_required"; missing: string[]; connectUrl: string }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "permission_required"; connectUrl: string }
  | { status: "refresh_failed" }
  | { status: "rate_limited"; retryAfter: string | null };

/**
 * An error Qonto reported for a request, such as an unknown transfer, invalid
 * input or a payment policy that needs another approver.
 */
export interface QontoError {
  /** The HTTP status Qonto answered with, such as 400 or 404. */
  status: number;
  /**
   * What failed, such as `{ code: "payment_policy_approval_required" }`, which
   * asks for a transfer request instead of a transfer.
   */
  errors: {
    code: string;
    detail?: string | undefined;
    /** The input that failed: a body field by JSON pointer, or a query parameter. */
    source?: { pointer?: string | undefined; parameter?: string | undefined } | undefined;
  }[];
  /** Qonto's identifier of the request, which its support asks for. */
  traceId: string | null;
}

/** What the next call needs to finish an action after Qonto's own approval. */
export interface ScaState {
  /** Qonto's approval session, valid for 15 minutes. */
  scaSessionToken: string;
  /** The idempotency key of the first request, which the approved request repeats. */
  idempotencyKey: string;
}

/**
 * Qonto's own approval: Qonto asked the user to approve the action in the Qonto
 * app on their paired phone. Widefleet shows the message, and the user answers
 * after approving there; the call then finishes the action.
 */
export interface ScaQuestion {
  resultType: "input_required";
  /** Absent: a question has no status, so callers can check either field. */
  status?: undefined;
  inputRequests: {
    approveInQonto: { message: string; requestedSchema: { type: "object"; properties: {} } };
  };
  requestState: ScaState;
}

/** A result other than a question, which has no `resultType`. */
export type Answered<R> = R & { resultType?: undefined };

/** The result of a Qonto method: the data, a question, or why there is no data. */
export type QontoResult<T> =
  | ApprovalQuestion
  | ScaQuestion
  | Answered<
      | { status: "connected"; data: T }
      | { status: "qonto_error"; error: QontoError }
      | { status: "declined" }
      | { status: "rejected_in_qonto" }
      | { status: "too_large"; maximumBytes: number }
      | ConnectionProblem
    >;
