import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, gt, inArray, lt, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "./database.ts";
import { enqueueAppRemoval } from "./apps.ts";
import { InvalidOperation } from "./errors.ts";
import {
  agents,
  connectors,
  apps,
  artifacts,
  deploymentEvents,
  deployments,
  fleets,
  jobReceipts,
  jobs,
} from "./schema.ts";
import {
  ensureFleetRuntime,
  loadRuntime,
  lockFleet,
  runtimeReference,
} from "./runtime-releases.ts";
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

      const [app] = candidate.job.appId
        ? await transaction
            .select()
            .from(apps)
            .where(eq(apps.id, candidate.job.appId))
            .for("update")
        : [];

      if (app && app.accessRevision > 0 && !accessRules && candidate.job.kind !== "delete")
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "Upgrade the agent to support app access rules before claiming this job",
          }),
        );

      let deploymentId = candidate.job.deploymentId;
      let artifactId = candidate.artifactId;

      if (candidate.job.kind === "configure") {
        deploymentId = app?.activeDeploymentId ?? null;

        const [active] = deploymentId
          ? await transaction
              .select({ artifactId: deployments.artifactId })
              .from(deployments)
              .where(eq(deployments.id, deploymentId))
          : [];

        artifactId = active?.artifactId ?? null;
      }

      const access = app
        ? contract.appAccessSnapshot.parse({
            revision: app.accessRevision,
            groups: app.accessGroups,
          })
        : null;

      const network = app
        ? contract.networkSnapshot.parse({
            revision: app.networkRevision,
            policy: app.networkPolicy,
          })
        : null;

      const capabilities = app
        ? contract.capabilitySnapshot.parse({
            revision: app.capabilityRevision,
            grants: app.capabilities,
          })
        : null;

      const installed = await transaction
        .select()
        .from(connectors)
        .where(eq(connectors.fleetId, fleet.id));

      let selectedConnectors = installed.flatMap((entry) =>
        entry.appliedPackage ? [connectorReference.parse(entry.appliedPackage)] : [],
      );

      if (candidate.job.kind === "connector") {
        const next = connectorReference.parse(candidate.job.connector);
        selectedConnectors = [
          ...selectedConnectors.filter((entry) => entry.name !== next.name),
          next,
        ];
      }

      selectedConnectors.sort((left, right) => left.name.localeCompare(right.name));

      const selectedRuntime =
        candidate.job.kind === "runtime"
          ? runtimeReference.parse(candidate.job.runtime)
          : fleet.appliedRuntime
            ? runtimeReference.parse(fleet.appliedRuntime)
            : await ensureFleetRuntime(transaction, storage, fleet.id);

      const [claimed] = await transaction
        .update(jobs)
        .set({
          state: "running",
          agentId,
          runtime: selectedRuntime,
          deploymentId,
          access,
          network,
          capabilities,
          connectors: selectedConnectors,
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
          access,
          network,
          capabilities,
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
  complete: async (agentId: string, jobId: string, result: z.infer<typeof contract.jobResult>) => {
    let event: z.infer<typeof contract.reportingOperation> | undefined;

    const completed = await transact(database, (transaction) =>
      Result.gen(async function* () {
        const [receipt] = await transaction
          .select()
          .from(jobReceipts)
          .where(
            and(
              eq(jobReceipts.jobId, jobId),
              eq(jobReceipts.agentId, agentId),
              eq(jobReceipts.leaseToken, result.leaseToken),
            ),
          );

        if (receipt) return Result.ok({ accepted: true });

        const lease = yield* Result.await(
          leasedJob(transaction, agentId, jobId, result.leaseToken),
        );

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
              .where(
                and(eq(connectors.fleetId, lease.fleetId), eq(connectors.name, reference.name)),
              );
          }

          await transaction
            .update(jobs)
            .set({ state: result.outcome, finishedAt: new Date(), result })
            .where(eq(jobs.id, jobId));
          await transaction
            .insert(jobReceipts)
            .values({ jobId, agentId, leaseToken: result.leaseToken })
            .onConflictDoUpdate({
              target: jobReceipts.jobId,
              set: { agentId, leaseToken: result.leaseToken },
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
            .values({ jobId, agentId, leaseToken: result.leaseToken })
            .onConflictDoUpdate({
              target: jobReceipts.jobId,
              set: { agentId, leaseToken: result.leaseToken },
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
                message: "The agent must confirm the active access revision",
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

        // A failed teardown remains retryable without reopening the app for writes.
        const state =
          lease.kind === "delete" && result.outcome === "failed" ? "queued" : result.outcome;

        await transaction
          .update(jobs)
          .set({ state, finishedAt: state === "queued" ? null : new Date(), result })
          .where(eq(jobs.id, jobId));
        await transaction
          .insert(jobReceipts)
          .values({ jobId, agentId, leaseToken: result.leaseToken })
          .onConflictDoUpdate({
            target: jobReceipts.jobId,
            set: { agentId, leaseToken: result.leaseToken },
          });

        return Result.ok({ accepted: true });
      }),
    );

    if (completed.isOk() && event) report(event);

    return completed;
  },
});
