import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "./database.ts";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import {
  installationRuntime,
  lockOrganizationRuntime,
  requireAgentExecution,
} from "./organization-runtime.ts";
import { loadPackage, savePackage, verifyModules } from "./package-storage.ts";
import type { Principal } from "./identity.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import { organizationRuntimes, jobs, runtimeReleases } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact, type Transaction } from "./transactions.ts";

export const runtimeReference = z.strictObject({
  version: contract.runtimeVersion,
  checksum: contract.checksum,
});

export const saveRuntime = async (
  transaction: Transaction,
  storage: Pick<ArtifactStorage, "put">,
  release: z.infer<typeof contract.runtimeRelease>,
) => {
  contract.runtimeRelease.parse(release);
  verifyModules(release);
  const bytes = Buffer.from(JSON.stringify(release));
  const checksum = createHash("sha256").update(bytes).digest("hex");

  const [existing] = await transaction
    .select()
    .from(runtimeReleases)
    .where(eq(runtimeReleases.version, release.version));

  if (existing && existing.checksum !== checksum)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "Runtime versions are immutable; publish a new version",
    });

  // Complete immutable storage before committing a database reference.
  await savePackage(storage, release);
  await transaction
    .insert(runtimeReleases)
    .values({ version: release.version, checksum })
    .onConflictDoNothing();

  return { version: release.version, checksum };
};

export const loadRuntime = async (
  storage: ArtifactStorage,
  input: z.infer<typeof runtimeReference>,
) => {
  const reference = runtimeReference.parse(input);
  const runtime = contract.runtimeRelease.parse(await loadPackage(storage, reference.checksum));

  if (runtime.version !== reference.version)
    throw new StorageUnavailable({ message: "Runtime artifact version mismatch", cause: null });

  return { runtime };
};

export const ensureOrganizationRuntime = async (
  transaction: Transaction,
  storage: ArtifactStorage,
  organizationId: string,
) => {
  const execution = await lockOrganizationRuntime(transaction, organizationId);

  if (execution.runtime) return runtimeReference.parse(execution.runtime);

  const { default: bundled } = await import("@platform/app-runtime/release", {
    with: { type: "json" },
  });

  const release = contract.runtimeRelease.parse(bundled);

  const reference = await saveRuntime(transaction, storage, release);
  await transaction
    .update(organizationRuntimes)
    .set({ runtime: reference })
    .where(eq(organizationRuntimes.organizationId, execution.organizationId));

  return reference;
};

const administrator = (principal: Principal) => {
  if (!principal.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Administrator permission is required",
    });
};

const status = async (transaction: Transaction) => {
  const target = await installationRuntime(transaction);
  const execution = await lockOrganizationRuntime(transaction, target.organizationId);
  const selected = execution.runtime ? runtimeReference.parse(execution.runtime) : null;

  const [job] = execution.runtimeJobId
    ? await transaction.select().from(jobs).where(eq(jobs.id, execution.runtimeJobId))
    : [];

  const active = execution.appliedRuntime ? runtimeReference.parse(execution.appliedRuntime) : null;
  const result = z.object({ message: z.string() }).safeParse(job?.result);

  return contract.runtimeStatus.parse({
    desiredVersion: selected?.version ?? null,
    jobId: execution.runtimeJobId,
    activeVersion: active?.version ?? null,
    state: job?.state ?? (active ? "succeeded" : "pending"),
    message: result.success ? result.data.message : null,
    versions: (
      await transaction.select().from(runtimeReleases).orderBy(desc(runtimeReleases.createdAt))
    ).map((release) => release.version),
  });
};

export const createRuntimeReleaseService = (
  database: Database,
  storage: ArtifactStorage,
  execution?: HostedExecution,
) => {
  const select = (
    principal: Principal,
    input: z.infer<typeof contract.runtimeRelease> | z.infer<typeof contract.runtimeUpdate>,
  ) =>
    transact(database, async (transaction) => {
      administrator(principal);
      const target = await installationRuntime(transaction);
      await lockOrganizationRuntime(transaction, target.organizationId);
      await requireAgentExecution(transaction, target.organizationId, "Runtime updates");
      let reference;

      if ("modules" in input) {
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
        reference = runtimeReference.parse({ version: saved.version, checksum: saved.checksum });
        // A rollback must also have its artifact available and intact.
        await loadRuntime(storage, reference);
      }

      const id = crypto.randomUUID();
      await transaction.insert(jobs).values({
        id,
        organizationId: target.organizationId,
        kind: "runtime",
        runtime: reference,
        rollback: !("modules" in input),
      });
      await transaction
        .update(organizationRuntimes)
        .set({ runtime: reference, runtimeJobId: id })
        .where(eq(organizationRuntimes.organizationId, target.organizationId));

      return Result.ok(await status(transaction));
    });

  return {
    read: (principal: Principal) =>
      execution
        ? execution.runtime.read(principal)
        : transact(database, async (transaction) => {
            administrator(principal);

            return Result.ok(await status(transaction));
          }),
    install: (principal: Principal, release: z.infer<typeof contract.runtimeRelease>) =>
      execution ? execution.runtime.select(principal, release) : select(principal, release),
    rollback: (principal: Principal, input: z.infer<typeof contract.runtimeUpdate>) =>
      execution ? execution.runtime.select(principal, input) : select(principal, input),
  };
};
