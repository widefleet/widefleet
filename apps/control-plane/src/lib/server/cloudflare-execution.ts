import { acceptCloudflareWorkflow } from "./cloudflare-admission.ts";
import { createCloudflareAppOperations } from "./cloudflare-app-operations.ts";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { validateAccessChange } from "./app-access.ts";
import { presentDeployment } from "./apps.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { registerCloudflareOperation } from "./cloudflare-operations.ts";
import type { Database } from "./database.ts";
import { deploymentCommand, type HostedExecution } from "./deployment-execution.ts";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { validateNetworkChange } from "./network.ts";
import { apps, artifacts, deployments } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

const unwrap = <T, E>(result: Result<T, E>) => {
  if (result.isErr()) throw result.error;

  return result.value;
};

export const createCloudflareExecution = (
  bindings: CloudflareBindings,
  database: Database,
  storage: ArtifactStorage,
): HostedExecution => {
  const admit = (requestedInput: z.infer<typeof deploymentCommand>) =>
    Result.tryPromise({
      try: async () => {
        const input = deploymentCommand.parse(requestedInput);
        const workflow = bindings.DEPLOYMENTS;

        if (!workflow) throw new Error("The deployment Workflow binding is missing");

        const command = await acceptCloudflareWorkflow(
          bindings.ARTIFACTS,
          workflow,
          input,
          deploymentCommand,
        );

        return unwrap(await registerCloudflareOperation(database, storage, command));
      },
      catch: (error) =>
        error instanceof InvalidOperation ||
        error instanceof DatabaseUnavailable ||
        error instanceof StorageUnavailable
          ? error
          : new StorageUnavailable({
              message: "Cloudflare could not accept the deployment",
              cause: error,
            }),
    });

  return {
    operations: createCloudflareAppOperations(bindings, database, storage),
    history: (records) =>
      Result.tryPromise({
        try: async () => {
          const workflow = bindings.DEPLOYMENTS;

          if (!workflow) throw new Error("The deployment Workflow binding is missing");
          const history = [];

          for (const record of records) {
            if (record.status !== "queued" && record.status !== "running") {
              history.push(record);
              continue;
            }

            const instance = await workflow.get(record.id);
            const state = await instance.status();
            // A terminal Workflow error remains visible even if SQL completion failed.
            history.push(
              state.status === "errored" || state.status === "terminated"
                ? {
                    ...record,
                    status: "failed" as const,
                    message: "Cloudflare stopped the deployment before completion",
                  }
                : record,
            );
          }

          return history;
        },
        catch: (cause) =>
          new StorageUnavailable({ message: "Cloudflare deployment status is unavailable", cause }),
      }),
    deploy: async (deployment, requestId, rollback = false) => {
      const valid = await transact(database, async (transaction) => {
        const [artifact] = await transaction
          .select()
          .from(artifacts)
          .where(
            and(eq(artifacts.id, deployment.artifactId), eq(artifacts.appId, deployment.appId)),
          );

        const [app] = await transaction.select().from(apps).where(eq(apps.id, deployment.appId));

        if (!artifact || !app)
          throw new InvalidOperation({
            code: "NOT_FOUND",
            message: "Deployment artifact not found",
          });
        contract.artifact.parse(
          contract.artifact.parse({
            id: artifact.id,
            appId: artifact.appId,
            metadata: artifact.metadata,
            manifest: artifact.manifest,
            modules: artifact.modules,
          }),
        );

        if (Object.keys(contract.capabilityGrants.parse(app.capabilities)).length)
          throw new InvalidOperation({
            code: "BAD_REQUEST",
            message: "Cloudflare connector deployment is not available yet",
          });

        return Result.ok(undefined);
      });

      if (valid.isErr()) return valid;

      const accepted = await admit({
        kind: "deploy",
        id: deployment.id,
        appId: deployment.appId,
        artifactId: deployment.artifactId,
        createdAt: deployment.createdAt,
        requestId,
        rollback,
      });

      if (accepted.isErr()) return accepted;

      return transact(database, async (transaction) => {
        const [record] = await transaction
          .select()
          .from(deployments)
          .where(eq(deployments.id, deployment.id));

        if (!record) throw new Error("The accepted deployment has no history");

        return Result.ok(presentDeployment(record));
      });
    },
    network: async (actor, appId, input) => {
      const allowed = await transact(database, (transaction) =>
        validateNetworkChange(transaction, actor, appId),
      );

      if (allowed.isErr()) return allowed;

      const accepted = await admit({
        kind: "network",
        id: crypto.randomUUID(),
        appId,
        actor,
        input,
        createdAt: new Date().toISOString(),
      });

      return accepted.map((record) => contract.networkState.parse(record.result));
    },
    access: async (actor, appId, input) => {
      const allowed = await transact(database, (transaction) =>
        validateAccessChange(transaction, actor, appId, input),
      );

      if (allowed.isErr()) return allowed;

      const accepted = await admit({
        kind: "access",
        id: crypto.randomUUID(),
        appId,
        actor,
        input,
        createdAt: new Date().toISOString(),
      });

      return accepted.map((record) => contract.appAccessState.parse(record.result));
    },
  };
};
