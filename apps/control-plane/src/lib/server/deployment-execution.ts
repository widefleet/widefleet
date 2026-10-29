import { applicationContext } from "./application-context.ts";
import * as contract from "@platform/contracts";
import { createHash } from "node:crypto";
import type { Result } from "better-result";
import type { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { z } from "zod";
import type { Principal } from "./identity.ts";

export const deploymentActor = z.object({
  id: z.string().min(1),
  admin: z.boolean(),
  application: applicationContext,
});

const command = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  createdAt: z.iso.datetime(),
});

export const deploymentCommand = z.discriminatedUnion("kind", [
  command.extend({
    kind: z.literal("deploy"),
    attribution: z
      .object({ userId: z.string().min(1), organizationId: z.string().min(1) })
      .optional(),
    artifactId: z.uuid(),
    requestId: z.string().min(1).max(128),
    rollback: z.boolean(),
  }),
  command.extend({
    kind: z.literal("network"),
    actor: deploymentActor,
    input: contract.networkChange,
  }),
  command.extend({
    kind: z.literal("capabilities"),
    actor: deploymentActor,
    name: contract.appSecretName,
    grant: contract.capabilityGrant.nullable(),
  }),
  command.extend({
    kind: z.literal("access"),
    actor: deploymentActor,
    input: contract.appAccessChange,
  }),
]);

// The same API idempotency key identifies the same deployment before its history exists.
export const operationId = (appId: string, requestId: string) => {
  const hash = createHash("sha256")
    .update(JSON.stringify([appId, requestId]))
    .digest("hex");

  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

type ExecutionResult<T> = Promise<
  Result<T, DatabaseUnavailable | InvalidOperation | StorageUnavailable>
>;

export type HostedExecution = {
  runtime: {
    read: (principal: Principal) => ExecutionResult<z.infer<typeof contract.runtimeStatus>>;
    select: (
      principal: Principal,
      input: z.infer<typeof contract.runtimeRelease> | z.infer<typeof contract.runtimeUpdate>,
    ) => ExecutionResult<z.infer<typeof contract.runtimeStatus>>;
  };
  remove: (principal: Principal, appId: string) => ExecutionResult<{ accepted: boolean }>;
  connections: {
    bind: (
      principal: Principal,
      appId: string,
      name: string,
      grant: z.infer<typeof contract.capabilityGrant> | null,
    ) => ExecutionResult<z.infer<typeof contract.capabilityState>>;
  };
  operations: {
    migrate: (
      principal: Principal,
      appId: string,
      id: string,
      input: z.infer<typeof contract.migrationRequest>,
    ) => Promise<
      Result<
        z.infer<typeof contract.migrationOperation>,
        DatabaseUnavailable | InvalidOperation | StorageUnavailable
      >
    >;
    workflow: (
      principal: Principal,
      appId: string,
      id: string,
      input: z.infer<typeof contract.workflowRequest>,
    ) => Promise<
      Result<
        z.infer<typeof contract.workflowOperation>,
        DatabaseUnavailable | InvalidOperation | StorageUnavailable
      >
    >;
    readMigration: (
      principal: Principal,
      appId: string,
      id: string,
    ) => Promise<
      Result<
        z.infer<typeof contract.migrationOperation>,
        DatabaseUnavailable | InvalidOperation | StorageUnavailable
      >
    >;
    readWorkflow: (
      principal: Principal,
      appId: string,
      id: string,
    ) => Promise<
      Result<
        z.infer<typeof contract.workflowOperation>,
        DatabaseUnavailable | InvalidOperation | StorageUnavailable
      >
    >;
  };
  history: (
    records: z.infer<typeof contract.deployment>[],
  ) => Promise<Result<z.infer<typeof contract.deployment>[], StorageUnavailable>>;
  deploy: (
    deployment: z.infer<typeof contract.deployment>,
    requestId: string,
    rollback?: boolean,
    actor?: z.infer<typeof deploymentActor>,
  ) => Promise<
    Result<
      z.infer<typeof contract.deployment>,
      DatabaseUnavailable | InvalidOperation | StorageUnavailable
    >
  >;
  network: (
    actor: z.infer<typeof deploymentActor>,
    appId: string,
    input: z.infer<typeof contract.networkChange>,
  ) => Promise<
    Result<
      z.infer<typeof contract.networkState>,
      DatabaseUnavailable | InvalidOperation | StorageUnavailable
    >
  >;
  access: (
    actor: z.infer<typeof deploymentActor>,
    appId: string,
    input: z.infer<typeof contract.appAccessChange>,
  ) => Promise<
    Result<
      z.infer<typeof contract.appAccessState>,
      DatabaseUnavailable | InvalidOperation | StorageUnavailable
    >
  >;
};
