import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { managedApp } from "./apps.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { artifacts, deployments, jobs } from "./schema.ts";
import { transact } from "./transactions.ts";

const present = (job: Pick<typeof jobs.$inferSelect, "id" | "state" | "result">) => {
  const result = job.result === null ? null : contract.jobResult.parse(job.result);

  return contract.workflowOperation.parse({
    id: job.id,
    state: job.state,
    message: result?.message ?? null,
    result: result?.workflow ?? null,
  });
};

export const createWorkflowService = (database: Database) => ({
  definitions: (principal: Principal, appId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      const [active] = access.value.activeDeploymentId
        ? await transaction
            .select({ metadata: artifacts.metadata })
            .from(deployments)
            .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
            .where(eq(deployments.id, access.value.activeDeploymentId))
        : [];

      return Result.ok(
        active
          ? contract.workerMetadata
              .parse(active.metadata)
              .bindings.filter((binding) => binding.type === "workflow")
          : [],
      );
    }),
  create: (
    principal: Principal,
    appId: string,
    requestId: string,
    input: z.infer<typeof contract.workflowRequest>,
  ) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;
      const request = contract.workflowRequest.parse(input);
      const [existing] = await transaction.select().from(jobs).where(eq(jobs.id, requestId));

      if (existing) {
        if (
          existing.appId !== appId ||
          existing.kind !== "workflows" ||
          JSON.stringify(contract.workflowRequest.parse(existing.workflow)) !==
            JSON.stringify(request)
        )
          return Result.err(
            new InvalidOperation({
              code: "CONFLICT",
              message: "This request ID already refers to another operation",
            }),
          );

        return Result.ok(present(existing));
      }

      if (access.value.state === "deleting" || !access.value.activeDeploymentId)
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "The app must be published and not being deleted",
          }),
        );

      const [created] = await transaction
        .insert(jobs)
        .values({
          id: requestId,
          fleetId: access.value.fleetId,
          appId,
          kind: "workflows",
          workflow: request,
        })
        .onConflictDoNothing()
        .returning();

      if (!created)
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "This request ID already refers to another operation",
          }),
        );

      return Result.ok(present(created));
    }),
  read: (principal: Principal, appId: string, jobId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      const [job] = await transaction
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.appId, appId), eq(jobs.kind, "workflows")));

      if (!job)
        return Result.err(
          new InvalidOperation({ code: "NOT_FOUND", message: "Workflow operation not found" }),
        );

      return Result.ok(present(job));
    }),
});
