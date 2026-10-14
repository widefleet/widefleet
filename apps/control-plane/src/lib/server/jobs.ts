import { lockFleet } from "./fleets.ts";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, gt, inArray, lt, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "./database.ts";
import { completeJob } from "./job-completion.ts";
import { InvalidOperation } from "./errors.ts";
import { agents, apps, artifacts, deploymentEvents, deployments, jobs } from "./schema.ts";
import { loadRuntime, runtimeReference } from "./runtime-releases.ts";
import { prepareJob } from "./job-preparation.ts";
import { decryptSecret } from "./secret-encryption.ts";
import { connectorReference, loadConnector } from "./connectors.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact, type Transaction } from "./transactions.ts";

const leasedJob = async (
  transaction: Transaction,
  agentId: string,
  jobId: string,
  leaseToken: string,
) => {
  const [record] = await transaction
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.agentId, agentId),
        eq(jobs.leaseToken, leaseToken),
        eq(jobs.state, "running"),
        gt(jobs.leaseUntil, sql`now()`),
      ),
    )
    .for("update");

  if (!record)
    return Result.err(
      new InvalidOperation({ code: "CONFLICT", message: "This job lease is no longer active" }),
    );

  return Result.ok(record);
};

export const createJobService = (
  database: Database,
  storage: ArtifactStorage,
  encryptionKey: string,
  report: (event: z.infer<typeof contract.reportingOperation>) => void = () => {},
) => ({
  authenticate: (token: string) =>
    transact(database, async (transaction) => {
      const [agent] = await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.tokenHash, createHash("sha256").update(token).digest("hex")),
            eq(agents.enabled, true),
          ),
        );

      if (!agent)
        return Result.err(
          new InvalidOperation({
            code: "FORBIDDEN",
            message: "Invalid or disabled agent credentials",
          }),
        );

      return Result.ok(agent);
    }),
  claim: (agentId: string, accessRules = false) =>
    transact(database, async (transaction) => {
      const [agent] = await transaction
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.enabled, true)));

      if (!agent) throw new InvalidOperation({ code: "FORBIDDEN", message: "Agent is disabled" });
      const fleet = await lockFleet(transaction, agent.fleetId);

      if (fleet.executor !== "agent")
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "Cloudflare executes this fleet's jobs",
        });
      const earlier = alias(jobs, "earlier_job");

      const [candidate] = await transaction
        .select({ job: jobs, hostname: apps.hostname, artifactId: deployments.artifactId })
        .from(jobs)
        .leftJoin(apps, eq(jobs.appId, apps.id))
        .leftJoin(deployments, eq(jobs.deploymentId, deployments.id))
        .where(
          and(
            eq(jobs.fleetId, agent.fleetId),
            or(
              eq(jobs.state, "queued"),
              and(eq(jobs.state, "running"), lt(jobs.leaseUntil, sql`now()`)),
            ),
            notExists(
              transaction
                .select({ id: earlier.id })
                .from(earlier)
                .where(
                  and(
                    eq(earlier.fleetId, jobs.fleetId),
                    lt(earlier.sequence, jobs.sequence),
                    inArray(earlier.state, ["queued", "running"]),
                  ),
                ),
            ),
          ),
        )
        .orderBy(jobs.sequence)
        .limit(1)
        .for("update", { of: jobs, skipLocked: true });

      await transaction
        .update(agents)
        .set({ lastSeenAt: new Date() })
        .where(eq(agents.id, agentId));

      if (!candidate) return Result.ok(null);

      const { artifactId, ...snapshot } = await prepareJob(
        transaction,
        storage,
        candidate.job,
        fleet,
        candidate.artifactId,
        accessRules,
      );

      const [claimed] = await transaction
        .update(jobs)
        .set({
          state: "running",
          agentId,
          ...snapshot,
          attempt: sql`${jobs.attempt} + 1`,
          leaseToken: crypto.randomUUID(),
          leaseUntil: sql`now() + interval '90 seconds'`,
        })
        .where(eq(jobs.id, candidate.job.id))
        .returning();

      if (!claimed) throw new Error("Job claim returned no row");

      if (claimed.deploymentId && claimed.kind === "deploy") {
        await transaction
          .update(deployments)
          .set({ status: "running" })
          .where(eq(deployments.id, claimed.deploymentId));
        await transaction.insert(deploymentEvents).values({
          deploymentId: claimed.deploymentId,
          level: "info",
          message: `Agent started attempt ${claimed.attempt}`,
        });
      }

      return Result.ok(
        contract.job.parse({
          id: claimed.id,
          fleetId: claimed.fleetId,
          kind: claimed.kind,
          migration: claimed.migration,
          workflow: claimed.workflow,
          appId: claimed.appId,
          hostname: candidate.hostname,
          deploymentId: claimed.deploymentId,
          artifactId,
          access: snapshot.access,
          network: snapshot.network,
          capabilities: snapshot.capabilities,
          attempt: claimed.attempt,
          leaseToken: claimed.leaseToken,
          leaseUntil: claimed.leaseUntil?.toISOString(),
        }),
      );
    }),
  heartbeat: (agentId: string, jobId: string, update: z.infer<typeof contract.jobUpdate>) =>
    transact(database, async (transaction) => {
      const lease = await leasedJob(transaction, agentId, jobId, update.leaseToken);

      if (lease.isErr()) return lease;

      const [record] = await transaction
        .update(jobs)
        .set({ leaseUntil: sql`now() + interval '90 seconds'` })
        .where(eq(jobs.id, jobId))
        .returning({ leaseUntil: jobs.leaseUntil });

      if (!record?.leaseUntil) throw new Error("Lease update returned no expiry");

      return Result.ok({ leaseUntil: record.leaseUntil.toISOString() });
    }),
  log: (agentId: string, jobId: string, update: z.infer<typeof contract.jobUpdate>) =>
    transact(database, async (transaction) => {
      const lease = await leasedJob(transaction, agentId, jobId, update.leaseToken);

      if (lease.isErr()) return lease;

      if (lease.value.deploymentId && lease.value.kind === "deploy")
        await transaction.insert(deploymentEvents).values({
          deploymentId: lease.value.deploymentId,
          level: "info",
          message: update.message,
        });

      return Result.ok({ recorded: true });
    }),
  packages: (agentId: string, jobId: string, leaseToken: string) =>
    transact(database, async (transaction) => {
      const lease = await leasedJob(transaction, agentId, jobId, leaseToken);

      if (lease.isErr()) return lease;

      const runtime = await loadRuntime(storage, runtimeReference.parse(lease.value.runtime));
      const references = z.array(connectorReference).parse(lease.value.connectors);

      const resolved = await Promise.all(
        references.map(async (reference) => {
          const values = await Promise.all(
            Object.entries(reference.secrets).map(
              async ([name, ciphertext]) =>
                [name, await decryptSecret(encryptionKey, ciphertext)] as const,
            ),
          );

          return [reference.name, Object.fromEntries(values)] as const;
        }),
      );

      return Result.ok({
        ...runtime,
        connectorSecrets: Object.fromEntries(resolved),
        connectors: await Promise.all(
          references.map((reference) => loadConnector(storage, reference)),
        ),
      });
    }),
  artifact: (agentId: string, jobId: string, leaseToken: string) =>
    transact(database, async (transaction) => {
      const lease = await leasedJob(transaction, agentId, jobId, leaseToken);

      if (lease.isErr()) return lease;

      if (!lease.value.deploymentId)
        return Result.err(
          new InvalidOperation({ code: "NOT_FOUND", message: "This job has no artifact" }),
        );

      const [record] = await transaction
        .select({ artifact: artifacts })
        .from(deployments)
        .innerJoin(artifacts, eq(deployments.artifactId, artifacts.id))
        .where(eq(deployments.id, lease.value.deploymentId));

      if (!record)
        return Result.err(
          new InvalidOperation({ code: "NOT_FOUND", message: "Artifact not found" }),
        );

      return Result.ok(
        contract.artifact.parse({
          id: record.artifact.id,
          appId: record.artifact.appId,
          metadata: record.artifact.metadata,
          manifest: record.artifact.manifest,
          modules: record.artifact.modules,
        }),
      );
    }),
  migrationArtifact: (agentId: string, jobId: string, leaseToken: string, checksum: string) =>
    transact(database, async (transaction) => {
      const lease = await leasedJob(transaction, agentId, jobId, leaseToken);

      if (lease.isErr()) return lease;

      if (lease.value.kind !== "migrations" || !lease.value.appId)
        return Result.err(
          new InvalidOperation({
            code: "NOT_FOUND",
            message: "This job has no migration artifact",
          }),
        );

      const reference = contract.migrationArtifact.parse(lease.value.migration);

      if (reference.sha256 !== checksum)
        return Result.err(
          new InvalidOperation({ code: "NOT_FOUND", message: "Migration artifact not found" }),
        );

      const stored = await storage.get(`apps/${lease.value.appId}/migrations/${checksum}`);

      if (stored.isErr()) throw stored.error;

      return Result.ok(stored.value);
    }),
  complete: (agentId: string, jobId: string, result: z.infer<typeof contract.jobResult>) =>
    completeJob(
      database,
      storage,
      { agentId, leaseToken: result.leaseToken },
      jobId,
      result,
      report,
    ),
});
