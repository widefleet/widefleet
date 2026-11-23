import type { JsonValue } from "./selection.ts";

/** Why a call could not use the user's Garmin data. `connectUrl` lets the user fix it. */
export type ConnectionProblem =
  | { status: "authentication_required" }
  | { status: "connection_required"; connectUrl: string }
  | { status: "reconnect_required"; connectUrl: string }
  | { status: "token_failed" }
  | { status: "rate_limited"; retryAfter: string | null };

/** An error Garmin answered a request with, such as a date range longer than the method allows. */
export interface GarminError {
  /** The HTTP status Garmin answered with. */
  status: number;
  /** The JSON Garmin sent with the error, or null when it sent none. */
  body: JsonValue | null;
}

/** The result of a Garmin Connect method: the data, or why there is no data. */
export type GarminConnectResult<T> =
  | { status: "connected"; data: T }
  | { status: "garmin_error"; error: GarminError }
  | { status: "too_large"; maximumBytes: number }
  | ConnectionProblem;
