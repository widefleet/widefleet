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

export type ObjectObservation = {
  timestamp: number;
  binding: string;
  operation:
    | "get"
    | "head"
    | "put"
    | "delete"
    | "list"
    | "createMultipartUpload"
    | "uploadPart"
    | "complete"
    | "abort";
  // One native binding call, including bulk/empty deletes and each list page.
  // Not an object count or a claim about provider requests or billing.
  count: 1;
  // Describes promise settlement, not later body consumption. A missing get/head
  // and an unmet get/put condition are distinct from rejected native calls.
  outcome: "ok" | "not_found" | "precondition_failed" | "error";
};

export interface RuntimeExtension {
  // Same parent-context delivery semantics as keyValue. Handle-only multipart
  // resume and failures before native invocation produce no observation.
  object?: (
    event: ObjectObservation,
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
