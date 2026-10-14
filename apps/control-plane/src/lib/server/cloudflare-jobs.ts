import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { defaultFleet, lockFleet } from "./fleets.ts";
import { prepareJob } from "./job-preparation.ts";
import { ownedJob } from "./job-completion.ts";
import { runtimeReference } from "./runtime-releases.ts";
import { apps, artifacts, deployments, deploymentEvents, jobs } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

export const createCloudflareJobService = (database: Database, storage: ArtifactStorage) => ({
  next: () =>
    transact(database, async (transaction) => {
      const fleet = await lockFleet(transaction, (await defaultFleet(transaction)).id);

      if (fleet.executor !== "cloudflare") return Result.ok(null);

      // Serialize this installation's jobs: runtime binding updates must not overwrite each other.
      const [candidate] = await transaction
        .select({ job: jobs, artifactId: deployments.artifactId })
        .from(jobs)
        .leftJoin(deployments, eq(jobs.deploymentId, deployments.id))
        .where(and(eq(jobs.fleetId, fleet.id), inArray(jobs.state, ["queued", "running"])))
        .orderBy(jobs.sequence)
        .limit(1);

      if (!candidate) return Result.ok(null);

      // Keep one durable execution per job, including the commit/create gap.
      if (candidate.job.workflowId) return Result.ok({ id: candidate.job.workflowId });

      if (candidate.job.state !== "queued")
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "An agent still owns the fleet's first job",
        });

      const { artifactId: _artifactId, ...snapshot } = await prepareJob(
        transaction,
        storage,
        candidate.job,
        fleet,
        candidate.artifactId,
        true,
      );

      const id = candidate.job.id;

      await transaction
        .update(jobs)
        .set({
          ...snapshot,
          workflowId: id,
          state: "running",
          attempt: 1,
        })
        .where(eq(jobs.id, id));

      if (candidate.job.deploymentId && candidate.job.kind === "deploy") {
        await transaction
          .update(deployments)
          .set({ status: "running" })
          .where(eq(deployments.id, candidate.job.deploymentId));
        await transaction.insert(deploymentEvents).values({
          deploymentId: candidate.job.deploymentId,
          level: "info",
          message: "Cloudflare started deployment",
        });
      }

      return Result.ok({ id });
    }),
  deployment: (workflowId: string) =>
    transact(database, async (transaction) => {
      const owned = await ownedJob(transaction, workflowId, { workflowId });

      if (owned.isErr()) return owned;

      const job = owned.value;

      if (job.kind !== "deploy" && job.kind !== "configure")
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: `Cloudflare execution for ${job.kind} jobs is not available yet`,
        });

      if (job.kind === "configure" && job.appId && !job.deploymentId) return Result.ok(null);

      if (!job.appId || !job.deploymentId)
        throw new InvalidOperation({ code: "CONFLICT", message: "This job has no app deployment" });

      const [record] = await transaction
        .select({ hostname: apps.hostname, artifact: artifacts })
        .from(deployments)
        .innerJoin(apps, eq(deployments.appId, apps.id))
        .innerJoin(artifacts, eq(deployments.artifactId, artifacts.id))
        .where(and(eq(deployments.id, job.deploymentId), eq(apps.id, job.appId)));

      if (!record)
        throw new InvalidOperation({ code: "NOT_FOUND", message: "Deployment artifact not found" });

      const artifact = contract.artifact.parse({
        id: record.artifact.id,
        appId: record.artifact.appId,
        metadata: record.artifact.metadata,
        manifest: record.artifact.manifest,
        modules: record.artifact.modules,
      });

      const capabilities = contract.capabilitySnapshot.parse(job.capabilities);

      if (
        artifact.metadata.crons.length ||
        artifact.metadata.queue_consumers.length ||
        artifact.metadata.bindings.some(
          (binding) => !["plain_text", "d1", "r2_bucket"].includes(binding.type),
        ) ||
        Object.keys(capabilities.grants).length
      )
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Cloudflare deployment currently supports plain-text, D1 and R2 bindings only",
        });

      return Result.ok({
        ...artifact,
        hostname: record.hostname,
        version: workflowId,
        deploymentId: job.deploymentId,
        access: contract.appAccessSnapshot.parse(job.access),
        network: contract.networkSnapshot.parse(job.network),
        capabilityRevision: capabilities.revision,
        runtime: runtimeReference.parse(job.runtime),
      });
    }),
});
