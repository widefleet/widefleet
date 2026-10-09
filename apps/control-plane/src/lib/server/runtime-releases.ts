import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Database } from "./database.ts";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import { defaultFleet } from "./fleets.ts";
import { loadPackage, savePackage, verifyModules } from "./package-storage.ts";
import type { Principal } from "./identity.ts";
import { fleets, jobs, runtimeReleases } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact, type Transaction } from "./transactions.ts";

export const runtimeReference = z.strictObject({
  version: contract.runtimeVersion,
  checksum: contract.checksum,
});

export const saveRuntime = async (
  transaction: Transaction,
  storage: ArtifactStorage,
  release: z.infer<typeof contract.runtimeRelease>,
) => {
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

export const lockFleet = async (transaction: Transaction, fleetId: string) => {
  const [fleet] = await transaction
    .select()
    .from(fleets)
    .where(eq(fleets.id, fleetId))
    .for("no key update");

  if (!fleet) throw new InvalidOperation({ code: "NOT_FOUND", message: "Fleet not found" });

  return fleet;
};

export const ensureFleetRuntime = async (
  transaction: Transaction,
  storage: ArtifactStorage,
  fleetId: string,
) => {
  const fleet = await lockFleet(transaction, fleetId);

  if (fleet.runtime) return runtimeReference.parse(fleet.runtime);

  const release = contract.runtimeRelease.parse(
    JSON.parse(
      await readFile(new URL(import.meta.resolve("@platform/app-runtime/release")), "utf8"),
    ),
  );

  const reference = await saveRuntime(transaction, storage, release);
  await transaction.update(fleets).set({ runtime: reference }).where(eq(fleets.id, fleet.id));

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
  const target = await defaultFleet(transaction);
  const fleet = await lockFleet(transaction, target.id);
  const selected = fleet.runtime ? runtimeReference.parse(fleet.runtime) : null;

  const [job] = fleet.runtimeJobId
    ? await transaction.select().from(jobs).where(eq(jobs.id, fleet.runtimeJobId))
    : [];

  const active = fleet.appliedRuntime ? runtimeReference.parse(fleet.appliedRuntime) : null;
  const result = z.object({ message: z.string() }).safeParse(job?.result);

  return contract.runtimeStatus.parse({
    desiredVersion: selected?.version ?? null,
    jobId: fleet.runtimeJobId,
    activeVersion: active?.version ?? null,
    state: job?.state ?? (active ? "succeeded" : "pending"),
    message: result.success ? result.data.message : null,
    versions: (
      await transaction.select().from(runtimeReleases).orderBy(desc(runtimeReleases.createdAt))
    ).map((release) => release.version),
  });
};

export const createRuntimeReleaseService = (database: Database, storage: ArtifactStorage) => {
  const select = (
    principal: Principal,
    input: z.infer<typeof contract.runtimeRelease> | z.infer<typeof contract.runtimeUpdate>,
  ) =>
    transact(database, async (transaction) => {
      administrator(principal);
      const target = await defaultFleet(transaction);
      await lockFleet(transaction, target.id);
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
        fleetId: target.id,
        kind: "runtime",
        runtime: reference,
        rollback: !("modules" in input),
      });
      await transaction
        .update(fleets)
        .set({ runtime: reference, runtimeJobId: id })
        .where(eq(fleets.id, target.id));

      return Result.ok(await status(transaction));
    });

  return {
    read: (principal: Principal) =>
      transact(database, async (transaction) => {
        administrator(principal);

        return Result.ok(await status(transaction));
      }),
    install: (principal: Principal, release: z.infer<typeof contract.runtimeRelease>) =>
      select(principal, release),
    rollback: (principal: Principal, input: z.infer<typeof contract.runtimeUpdate>) =>
      select(principal, input),
  };
};
