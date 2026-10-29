import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { acceptCloudflareWorkflow } from "./cloudflare-admission.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { deploymentWorkflowCommand } from "./deployment-workflow-command.ts";
import { cloudflareRuntimeCommand } from "./cloudflare-runtime-command.ts";
import {
  readCloudflareRuntimeVersion,
  validateCloudflareRuntime,
} from "./cloudflare-runtime-package.ts";
import { administrator } from "./capability-changes.ts";
import type { Database } from "./database.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { installationRuntime, lockOrganizationRuntime } from "./organization-runtime.ts";
import { loadRuntime, runtimeReference, saveRuntime } from "./runtime-releases.ts";
import { cloudflareOperations, organizationRuntimes, runtimeReleases } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

export const registerCloudflareRuntime = (
  database: Database,
  storage: ArtifactStorage,
  command: z.infer<typeof cloudflareRuntimeCommand>,
) =>
  transact(database, async (transaction) => {
    administrator(command.actor);
    const execution = await lockOrganizationRuntime(transaction, command.organizationId);

    if (execution.executor !== "cloudflare")
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "This installation does not use Cloudflare execution",
      });

    const [existing] = await transaction
      .select()
      .from(cloudflareOperations)
      .where(eq(cloudflareOperations.id, command.id));

    if (existing) {
      if (!isDeepStrictEqual(existing.command, command))
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "The operation ID already refers to another command",
        });

      return Result.ok(existing);
    }

    // A delayed first registration must not replace a selection made since preparation.
    if (execution.runtimeJobId !== command.previousJobId)
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "A newer runtime update superseded this operation",
      });

    const { runtime } = await loadRuntime(storage, command.runtime);
    validateCloudflareRuntime(runtime);
    await saveRuntime(transaction, storage, runtime);

    const [record] = await transaction
      .insert(cloudflareOperations)
      .values({
        id: command.id,
        organizationId: execution.organizationId,
        command,
        targets: [],
        result: command.runtime,
        createdAt: new Date(command.createdAt),
      })
      .returning();

    if (!record) throw new Error("Runtime operation history is missing");
    await transaction
      .update(organizationRuntimes)
      .set({ runtime: command.runtime, runtimeJobId: command.id })
      .where(eq(organizationRuntimes.organizationId, execution.organizationId));

    return Result.ok(record);
  });

export const createCloudflareRuntimeReleases = (
  bindings: CloudflareBindings,
  database: Database,
  storage: ArtifactStorage,
): HostedExecution["runtime"] => {
  const status = async (command?: z.infer<typeof cloudflareRuntimeCommand>) => {
    const saved = await transact(database, async (transaction) => {
      const execution = await installationRuntime(transaction);
      const id = command?.id ?? execution.runtimeJobId;

      const selected =
        command?.runtime ?? (execution.runtime ? runtimeReference.parse(execution.runtime) : null);

      const [operation] = id
        ? await transaction
            .select()
            .from(cloudflareOperations)
            .where(
              and(
                eq(cloudflareOperations.id, id),
                eq(cloudflareOperations.organizationId, execution.organizationId),
              ),
            )
        : [];

      return Result.ok({
        selected,
        // Infrastructure deployments advance the selection marker without
        // creating a Workflow operation. Only real jobs have a native status.
        id: operation ? id : null,
        operation,
        versions: (
          await transaction.select().from(runtimeReleases).orderBy(desc(runtimeReleases.createdAt))
        ).map((release) => release.version),
      });
    });

    if (saved.isErr()) throw saved.error;

    const snapshot = saved.value;

    let state: z.infer<typeof contract.runtimeStatus>["state"] = snapshot.operation?.finishedAt
      ? snapshot.operation.error
        ? "failed"
        : "succeeded"
      : snapshot.id
        ? "queued"
        : "pending";

    let message = snapshot.operation?.error ?? null;

    if (snapshot.id && !snapshot.operation?.finishedAt) {
      if (!bindings.DEPLOYMENTS) throw new Error("The deployment Workflow binding is missing");
      const native = await (await bindings.DEPLOYMENTS.get(snapshot.id)).status();

      if (native.status === "errored" || native.status === "terminated") {
        state = "failed";
        message = "Cloudflare stopped the runtime update before completion";
      } else if (native.status !== "queued") state = "running";
    }

    const active = await Result.tryPromise(() => readCloudflareRuntimeVersion(bindings));

    if (!snapshot.id && active.isOk() && snapshot.selected?.version === active.value)
      state = "succeeded";

    return contract.runtimeStatus.parse({
      desiredVersion: snapshot.selected?.version ?? null,
      jobId: snapshot.id,
      activeVersion: active.isOk() ? active.value : null,
      state,
      message:
        message ?? (active.isErr() ? "The active runtime version could not be verified" : null),
      versions: snapshot.versions,
    });
  };

  const failure = (cause: unknown) =>
    cause instanceof InvalidOperation ||
    cause instanceof DatabaseUnavailable ||
    cause instanceof StorageUnavailable
      ? cause
      : new StorageUnavailable({ message: "Cloudflare runtime operation is unavailable", cause });

  return {
    read: (principal) =>
      Result.tryPromise({
        try: async () => {
          administrator(principal);

          return status();
        },
        catch: failure,
      }),
    select: (principal, input) =>
      Result.tryPromise({
        try: async () => {
          administrator(principal);

          const prepared = await transact(database, async (transaction) => {
            const execution = await lockOrganizationRuntime(
              transaction,
              (await installationRuntime(transaction)).organizationId,
            );

            let reference;

            if ("modules" in input) {
              validateCloudflareRuntime(input);
              reference = await saveRuntime(transaction, storage, input);
            } else {
              const [saved] = await transaction
                .select()
                .from(runtimeReleases)
                .where(eq(runtimeReleases.version, input.version));

              if (!saved)
                throw new InvalidOperation({
                  code: "NOT_FOUND",
                  message: "This runtime version has not been installed",
                });
              reference = runtimeReference.parse({
                version: saved.version,
                checksum: saved.checksum,
              });
              validateCloudflareRuntime((await loadRuntime(storage, reference)).runtime);
            }

            return Result.ok({
              organizationId: execution.organizationId,
              previousJobId: execution.runtimeJobId,
              runtime: reference,
            });
          });

          if (prepared.isErr()) throw prepared.error;

          const workflow = bindings.DEPLOYMENTS;

          if (!workflow) throw new Error("The deployment Workflow binding is missing");

          const command = cloudflareRuntimeCommand.parse({
            kind: "runtime",
            id: crypto.randomUUID(),
            ...prepared.value,
            actor: principal,
            createdAt: new Date().toISOString(),
            rollback: !("modules" in input),
          });

          await acceptCloudflareWorkflow(
            bindings.ARTIFACTS,
            workflow,
            command,
            deploymentWorkflowCommand,
          );
          const registered = await registerCloudflareRuntime(database, storage, command);

          if (registered.isErr()) throw registered.error;

          return status(command);
        },
        catch: failure,
      }),
  };
};
