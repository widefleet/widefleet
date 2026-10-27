import type { TraceItem } from "@cloudflare/workers-types";
import type { z } from "zod";

export type WorkerIdentity =
  | { appId: string; deploymentId: string; buildId: string | null }
  | { organizationId: string; connector: string; connectorVersion: string };

export type KeyValueObservation = {
  timestamp: number;
  binding: string;
  operation: "read" | "write" | "delete" | "list";
  // Requested keys (including misses), or one list call. Errors remain attempts,
  // not a claim that the provider billed every requested operation.
  count: number;
  outcome: "ok" | "error";
};

export type DatabaseObservation = {
  timestamp: number;
  binding: string;
  // The existing facade routes run() through all(). No SQL classification.
  operation: "all" | "first" | "raw" | "batch" | "exec";
  // One event per native _send, before first/raw/exec project away metadata.
  // Outcome describes that native response, not subsequent JS projection errors.
  outcome: "ok" | "error" | "unknown";
  statements: number;
  // Sum each returned statement once. A missing counter or response makes that
  // entire dimension unknown. Native retry totals are never multiplied.
  rowsRead: number | null;
  rowsWritten: number | null;
};

export interface RuntimeExtension {
  database?: (
    event: DatabaseObservation,
    identity: WorkerIdentity,
    binding: <Value>(name: string, schema: z.ZodType<Value>) => Value,
  ) => Promise<void>;
  // Runs in the parent request context. KV calls do not await delivery, but
  // synchronous work in the callback still contributes to request latency.
  keyValue?: (
    event: KeyValueObservation,
    identity: WorkerIdentity,
    binding: <Value>(name: string, schema: z.ZodType<Value>) => Value,
  ) => Promise<void>;
  tail?: (
    events: TraceItem[],
    identity: WorkerIdentity,
    binding: <Value>(name: string, schema: z.ZodType<Value>) => Value,
  ) => Promise<void>;
}

// Installations may replace this module when building their runtime.
export const runtimeExtension: RuntimeExtension = {};
