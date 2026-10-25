import type { TraceItem } from "@cloudflare/workers-types";
import type { z } from "zod";

export type WorkerIdentity =
  | { appId: string; deploymentId: string; buildId: string | null }
  | { organizationId: string; connector: string; connectorVersion: string };

export interface RuntimeExtension {
  tail?: (
    events: TraceItem[],
    identity: WorkerIdentity,
    binding: <Value>(name: string, schema: z.ZodType<Value>) => Value,
  ) => Promise<void>;
}

// Installations may replace this module when building their runtime.
export const runtimeExtension: RuntimeExtension = {};
