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

export interface RuntimeExtension {
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
