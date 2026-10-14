import * as contract from "@platform/contracts";
import { createHash } from "node:crypto";
import type { Result } from "better-result";
import type { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { z } from "zod";

export const deploymentActor = z.object({ id: z.string().min(1), admin: z.boolean() });

const command = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  createdAt: z.iso.datetime(),
});

export const deploymentCommand = z.discriminatedUnion("kind", [
  command.extend({
    kind: z.literal("deploy"),
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
    kind: z.literal("access"),
    actor: deploymentActor,
    input: contract.appAccessChange,
  }),
]);

// The same API idempotency key identifies the same deployment before its history exists.
export const hostedDeploymentId = (appId: string, requestId: string) => {
  const hash = createHash("sha256")
    .update(JSON.stringify([appId, requestId]))
    .digest("hex");

  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

export type HostedExecution = {
  history: (
    records: z.infer<typeof contract.deployment>[],
  ) => Promise<Result<z.infer<typeof contract.deployment>[], StorageUnavailable>>;
  deploy: (
    deployment: z.infer<typeof contract.deployment>,
    requestId: string,
    rollback?: boolean,
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
