import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { acceptCloudflareWorkflow } from "./cloudflare-admission.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { deploymentWorkflowCommand } from "./cloudflare-connector-command.ts";
import { cloudflareRuntimeCommand } from "./cloudflare-runtime-command.ts";
import {
  readCloudflareRuntimeVersion,
  validateCloudflareRuntime,
} from "./cloudflare-runtime-package.ts";
import { administrator } from "./connector-changes.ts";
import type { Database } from "./database.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { defaultFleet, lockFleet } from "./fleets.ts";
import { loadRuntime, runtimeReference, saveRuntime } from "./runtime-releases.ts";
import { cloudflareOperations, fleets, runtimeReleases } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

export const registerCloudflareRuntime = (
  database: Database,
  storage: ArtifactStorage,
  command: z.infer<typeof cloudflareRuntimeCommand>,
) =>
  transact(database, async (transaction) => {
    administrator(command.actor);
    const fleet = await lockFleet(transaction, command.fleetId);

    if (fleet.executor !== "cloudflare")
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
    if (fleet.runtimeJobId !== command.previousJobId)
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
        fleetId: fleet.id,
        command,
        targets: [],
        result: command.runtime,
        createdAt: new Date(command.createdAt),
      })
      .returning();

    if (!record) throw new Error("Runtime operation history is missing");
    await transaction
      .update(fleets)
      .set({ runtime: command.runtime, runtimeJobId: command.id })
      .where(eq(fleets.id, fleet.id));

    return Result.ok(record);
  });

export const createCloudflareRuntimeReleases = (
  bindings: CloudflareBindings,
  database: Database,
  storage: ArtifactStorage,
): HostedExecution["runtime"] => {
  const status = async (command?: z.infer<typeof cloudflareRuntimeCommand>) => {
    const saved = await transact(database, async (transaction) => {
      const fleet = await defaultFleet(transaction);
      const id = command?.id ?? fleet.runtimeJobId;

      const selected =
        command?.runtime ?? (fleet.runtime ? runtimeReference.parse(fleet.runtime) : null);

      const [operation] = id
        ? await transaction
            .select()
            .from(cloudflareOperations)
            .where(and(eq(cloudflareOperations.id, id), eq(cloudflareOperations.fleetId, fleet.id)))
        : [];

      return Result.ok({
        selected,
        id,
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
            const fleet = await lockFleet(transaction, (await defaultFleet(transaction)).id);
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
              fleetId: fleet.id,
              previousJobId: fleet.runtimeJobId,
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
