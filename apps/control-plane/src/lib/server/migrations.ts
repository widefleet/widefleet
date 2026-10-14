import type { HostedExecution } from "./deployment-execution.ts";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { requireAgentExecution } from "./fleets.ts";
import { managedApp } from "./apps.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { artifacts, deployments, jobs } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

const operationColumns = { id: jobs.id, state: jobs.state, result: jobs.result };

const present = (job: Pick<typeof jobs.$inferSelect, "id" | "state" | "result">) => {
  const result = job.result === null ? null : contract.jobResult.parse(job.result);

  return contract.migrationOperation.parse({
    id: job.id,
    state: job.state,
    message: result?.message ?? null,
    entries: result?.migrations ?? null,
  });
};

export const createMigrationService = (
  database: Database,
  storage: ArtifactStorage,
  execution?: HostedExecution,
) => ({
  create: async (
    principal: Principal,
    appId: string,
    requestId: string,
    input: z.infer<typeof contract.migrationRequest>,
  ) => {
    const prepared = await transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;
      const app = access.value;

      if (!execution) await requireAgentExecution(transaction, app.fleetId, "D1 migrations");
      // Parsing fixes object key order so equivalent requests produce the same artifact.
      const bytes = Buffer.from(JSON.stringify(contract.migrationRequest.parse(input)));

      const reference = contract.migrationArtifact.parse({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      });

      const [existing] = await transaction.select().from(jobs).where(eq(jobs.id, requestId));

      if (existing) {
        if (
          existing.appId !== appId ||
          existing.kind !== "migrations" ||
          contract.migrationArtifact.parse(existing.migration).sha256 !== reference.sha256
        )
          return Result.err(
            new InvalidOperation({
              code: "CONFLICT",
              message: "This request ID already refers to another operation",
            }),
          );

        return Result.ok(present(existing));
      }

      if (app.state === "deleting")
        return Result.err(
          new InvalidOperation({ code: "CONFLICT", message: "The app is being deleted" }),
        );

      const [active] = app.activeDeploymentId
        ? await transaction
            .select({ metadata: artifacts.metadata })
            .from(deployments)
            .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
            .where(and(eq(deployments.id, app.activeDeploymentId), eq(deployments.appId, appId)))
        : [];

      if (!active)
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "Deploy the app's D1 binding before running migrations",
          }),
        );

      const binding = contract.workerMetadata
        .parse(active.metadata)
        .bindings.find((entry) => entry.type === "d1" && entry.name === input.database);

      if (
        binding?.type !== "d1" ||
        (binding.database_id ?? binding.database_name) !== input.databaseId
      )
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "The selected database does not match the deployed D1 binding",
          }),
        );

      if (execution)
        return Result.ok(
          contract.migrationOperation.parse({
            id: requestId,
            state: "queued",
            message: null,
            entries: null,
          }),
        );

      // As with app modules, finish immutable storage before committing the job reference.
      const stored = await storage.put(
        `apps/${appId}/migrations/${reference.sha256}`,
        bytes,
        "application/json",
      );

      if (stored.isErr()) throw stored.error;

      const [created] = await transaction
        .insert(jobs)
        .values({
          id: requestId,
          fleetId: app.fleetId,
          appId,
          kind: "migrations",
          migration: reference,
        })
        .onConflictDoNothing()
        .returning(operationColumns);

      if (!created)
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "This request ID already refers to another operation",
          }),
        );

      return Result.ok(present(created));
    });

    if (prepared.isErr() || !execution) return prepared;

    return execution.operations.migrate(principal, appId, requestId, input);
  },
  read: (principal: Principal, appId: string, jobId: string) =>
    execution
      ? execution.operations.readMigration(principal, appId, jobId)
      : transact(database, async (transaction) => {
          const access = await managedApp(transaction, principal, appId);

          if (access.isErr()) return access;

          const [job] = await transaction
            .select(operationColumns)
            .from(jobs)
            .where(and(eq(jobs.id, jobId), eq(jobs.appId, appId), eq(jobs.kind, "migrations")));

          if (!job)
            return Result.err(
              new InvalidOperation({ code: "NOT_FOUND", message: "Migration operation not found" }),
            );

          return Result.ok(present(job));
        }),
});
