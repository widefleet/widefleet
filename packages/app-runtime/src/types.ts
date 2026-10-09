import type { workerMetadata, publishedApp } from "@platform/contracts";
import type { z } from "zod";

export type Json = z.infer<ReturnType<typeof z.json>>;

export type Metadata = z.infer<typeof workerMetadata>;

export type PublishedApp = z.infer<typeof publishedApp>;

export type NativeBindings = {
  d1: D1Database;
  r2_bucket: R2Bucket;
  kv_namespace: KVNamespace;
  queue: Queue<Json | ArrayBuffer>;
};

export type ParentEnvironment = {
  WIDEFLEET_WORKFLOW_SESSIONS: Service<import("./workflow-host.ts").WorkflowSessions>;
  WIDEFLEET_WORKFLOW_CATALOG: DurableObjectNamespace<
    import("./workflow-catalog.ts").WorkflowCatalog
  >;
  WIDEFLEET_WORKFLOWS: Workflow<import("./workflow-protocol.ts").Start>;
  WIDEFLEET_LOADER: WorkerLoader;
  WIDEFLEET_PACKAGES: R2Bucket;
  WIDEFLEET_CONTROL_TOKEN: string;
  WIDEFLEET_CONFIGURATION: string;
  [name: string]:
    | NativeBindings[keyof NativeBindings]
    | string
    | Fetcher
    | WorkerLoader
    | Workflow<import("./workflow-protocol.ts").Start>
    | DurableObjectNamespace<import("./workflow-catalog.ts").WorkflowCatalog>;
};

export type BindingProperties = { name: string };

export type ScheduledInput = { cron: string; scheduledTime: number };

export type QueueInput = {
  queue: string;
  metadata: MessageBatch<Json>["metadata"];
  messages: { id: string; body: Json | ArrayBuffer; timestamp: Date; attempts: number }[];
};

export type Settlement = { id: string; action: "ack" | "retry"; options?: QueueRetryOptions };
