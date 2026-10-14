import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, gt, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Database } from "./database.ts";
import { enqueueAppRemoval } from "./apps.ts";
import { InvalidOperation } from "./errors.ts";
import {
  apps,
  connectors,
  deployments,
  deploymentEvents,
  fleets,
  jobReceipts,
  jobs,
} from "./schema.ts";
import { connectorReference } from "./connectors.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact, type Transaction } from "./transactions.ts";

type Owner = { agentId: string; leaseToken: string } | { workflowId: string };

const receiptOwner = (owner: Owner) =>
  "agentId" in owner
    ? { ...owner, workflowId: null }
    : { ...owner, agentId: null, leaseToken: null };

export const ownedJob = async (transaction: Transaction, jobId: string, owner: Owner) => {
  const [record] = await transaction
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.state, "running"),
        "agentId" in owner
          ? and(
              eq(jobs.agentId, owner.agentId),
              eq(jobs.leaseToken, owner.leaseToken),
              gt(jobs.leaseUntil, sql`now()`),
            )
          : eq(jobs.workflowId, owner.workflowId),
      ),
    )
    .for("update");

  if (!record)
    return Result.err(
      new InvalidOperation({ code: "CONFLICT", message: "This job execution is no longer active" }),
    );

  return Result.ok(record);
};

export const completeJob = async (
  database: Database,
  storage: ArtifactStorage,
  owner: Owner,
  jobId: string,
  result: Omit<z.infer<typeof contract.jobResult>, "leaseToken">,
  report: (event: z.infer<typeof contract.reportingOperation>) => void = () => {},
  activate?: () => Promise<void>,
) => {
  let event: z.infer<typeof contract.reportingOperation> | undefined;

  const completed = await transact(database, (transaction) =>
    Result.gen(async function* () {
      const [receipt] = await transaction
        .select()
        .from(jobReceipts)
        .where(
          and(
            eq(jobReceipts.jobId, jobId),
            "agentId" in owner
              ? and(
                  eq(jobReceipts.agentId, owner.agentId),
                  eq(jobReceipts.leaseToken, owner.leaseToken),
                )
              : eq(jobReceipts.workflowId, owner.workflowId),
          ),
        );

      if (receipt) return Result.ok({ accepted: true });

      const lease = yield* Result.await(ownedJob(transaction, jobId, owner));

      if ("workflowId" in owner && lease.activationStartedAt && result.outcome === "failed")
        return yield* new InvalidOperation({
          code: "CONFLICT",
          message: "Activation must be reconciled before completing this job",
        });

      event = {
        operation:
          lease.kind === "runtime"
            ? lease.rollback
              ? "runtime_rollback"
              : "runtime_update"
            : lease.kind === "deploy" && lease.rollback
              ? "rollback"
              : lease.kind,
        outcome: result.outcome,
        elapsed_ms: Math.max(0, Date.now() - lease.createdAt.getTime()),
        attempt: lease.attempt,
      };

      if (
        lease.kind === "runtime" ||
        lease.kind === "connector" ||
        lease.kind === "migrations" ||
        lease.kind === "workflows"
      ) {
        if (
          lease.kind === "workflows" &&
          result.outcome === "succeeded" &&
          result.workflow === undefined
        )
          return yield* new InvalidOperation({
            code: "BAD_REQUEST",
            message: "Workflow completion requires a result",
          });

        if (lease.kind === "migrations" && result.outcome === "succeeded" && !result.migrations)
          return yield* new InvalidOperation({
            code: "BAD_REQUEST",
            message: "Migration completion requires a file status result",
          });

        if (
          result.outcome === "succeeded" &&
          lease.kind !== "migrations" &&
          lease.kind !== "workflows"
        ) {
          await transaction
            .update(fleets)
            .set({ appliedRuntime: lease.runtime })
            .where(eq(fleets.id, lease.fleetId));
        }

        if (lease.kind === "connector" && result.outcome === "succeeded") {
          const reference = connectorReference.parse(lease.connector);
          await transaction
            .update(connectors)
            .set({ appliedPackage: reference })
            .where(and(eq(connectors.fleetId, lease.fleetId), eq(connectors.name, reference.name)));
        }

        await transaction
          .update(jobs)
          .set({ state: result.outcome, finishedAt: new Date(), result })
          .where(eq(jobs.id, jobId));
        await transaction
          .insert(jobReceipts)
          .values({ jobId, ...receiptOwner(owner) })
          .onConflictDoUpdate({
            target: jobReceipts.jobId,
            set: receiptOwner(owner),
          });

        return Result.ok({ accepted: true });
      }

      if (!lease.appId)
        return yield* new InvalidOperation({
          code: "CONFLICT",
          message: "App job has no application",
        });

      const [app] = await transaction
        .select()
        .from(apps)
        .where(eq(apps.id, lease.appId))
        .for("update");

      if (!app)
        return yield* new InvalidOperation({
          code: "NOT_FOUND",
          message: "App no longer exists",
        });

      if (lease.kind === "delete" && result.outcome === "succeeded") {
        // Also cover deletion jobs queued before descendant cleanup was introduced.
        await enqueueAppRemoval(transaction, app);
        yield* Result.await(storage.removeApp(app.id));
        await transaction
          .insert(jobReceipts)
          .values({ jobId, ...receiptOwner(owner) })
          .onConflictDoUpdate({
            target: jobReceipts.jobId,
            set: receiptOwner(owner),
          });
        await transaction.delete(apps).where(eq(apps.id, app.id));

        return Result.ok({ accepted: true });
      }

      if (lease.deploymentId && lease.kind === "deploy") {
        await transaction
          .update(deployments)
          .set({ status: result.outcome, finishedAt: new Date(), message: result.message })
          .where(eq(deployments.id, lease.deploymentId));
        await transaction.insert(deploymentEvents).values({
          deploymentId: lease.deploymentId,
          level: result.outcome === "succeeded" ? "info" : "error",
          message: result.message,
        });

        if (result.outcome === "succeeded") {
          await transaction
            .update(fleets)
            .set({ appliedRuntime: lease.runtime })
            .where(eq(fleets.id, lease.fleetId));
          await transaction
            .update(apps)
            .set({
              activeDeploymentId: lease.deploymentId,
              state: app.state === "deleting" ? "deleting" : "active",
            })
            .where(eq(apps.id, app.id));
        }
      }

      if (lease.kind !== "delete") {
        const network = contract.networkSnapshot.parse(lease.network);

        if (result.outcome === "succeeded" && lease.deploymentId)
          await transaction
            .update(apps)
            .set({ appliedNetworkRevision: network.revision })
            .where(eq(apps.id, app.id));

        if (network.revision === app.networkRevision)
          await transaction
            .update(apps)
            .set({
              networkError:
                result.outcome === "failed" && app.appliedNetworkRevision !== network.revision
                  ? result.message
                  : null,
            })
            .where(eq(apps.id, app.id));
      }

      if (lease.kind !== "delete" && lease.access) {
        const snapshot = contract.appAccessSnapshot.parse(lease.access);

        if (result.outcome === "succeeded" && lease.deploymentId) {
          if (snapshot.revision > 0 && result.accessRevision !== snapshot.revision)
            return yield* new InvalidOperation({
              code: "CONFLICT",
              message: "The executor must confirm the active access revision",
            });
          await transaction
            .update(apps)
            .set({ appliedAccessRevision: snapshot.revision })
            .where(eq(apps.id, app.id));
        }

        if (snapshot.revision === app.accessRevision)
          await transaction
            .update(apps)
            .set({
              accessError:
                result.outcome === "failed" && app.appliedAccessRevision !== snapshot.revision
                  ? result.message
                  : null,
            })
            .where(eq(apps.id, app.id));
      }

      if (lease.kind !== "delete" && lease.capabilities) {
        const snapshot = contract.capabilitySnapshot.parse(lease.capabilities);

        if (result.outcome === "succeeded" && lease.deploymentId)
          await transaction
            .update(apps)
            .set({ appliedCapabilityRevision: snapshot.revision })
            .where(eq(apps.id, app.id));

        if (snapshot.revision === app.capabilityRevision)
          await transaction
            .update(apps)
            .set({
              capabilityError:
                result.outcome === "failed" && app.appliedCapabilityRevision !== snapshot.revision
                  ? result.message
                  : null,
            })
            .where(eq(apps.id, app.id));
      }

      // Hold ownership until the R2 host pointer and the SQL receipt are committed.
      // A repeated completion must not publish an older version over a newer job.
      if (result.outcome === "succeeded") await activate?.();

      // Agent teardown retries retain their existing queue behavior.
      const state =
        lease.kind === "delete" && result.outcome === "failed" && "agentId" in owner
          ? "queued"
          : result.outcome;

      await transaction
        .update(jobs)
        .set({ state, finishedAt: state === "queued" ? null : new Date(), result })
        .where(eq(jobs.id, jobId));
      await transaction
        .insert(jobReceipts)
        .values({ jobId, ...receiptOwner(owner) })
        .onConflictDoUpdate({
          target: jobReceipts.jobId,
          set: receiptOwner(owner),
        });

      return Result.ok({ accepted: true });
    }),
  );

  if (completed.isOk() && event) report(event);

  return completed;
};
