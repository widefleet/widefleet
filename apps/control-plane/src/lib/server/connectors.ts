import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { managedApp } from "./apps.ts";
import type { Database } from "./database.ts";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import { encryptSecret } from "./secret-encryption.ts";
import { defaultFleet } from "./fleets.ts";
import type { Principal } from "./identity.ts";
import { loadPackage, savePackage } from "./package-storage.ts";
import { lockFleet } from "./runtime-releases.ts";
import { apps, artifacts, connectors, deployments, jobs } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact, type Transaction } from "./transactions.ts";

export const connectorReference = z.strictObject({
  name: contract.appSlug,
  checksum: contract.checksum,
  entrypoints: contract.connectorPackage.shape.entrypoints,
  classes: z.array(z.string()),
  // Ciphertexts belong to the activation snapshot, independently of login settings.
  secrets: z.record(contract.connectorSecretName, z.string().min(1)).default({}),
  secretRevision: z.number().int().nonnegative().default(0),
});

export const loadConnector = async (
  storage: ArtifactStorage,
  reference: z.infer<typeof connectorReference>,
) => {
  const value = contract.connectorPackage.parse(await loadPackage(storage, reference.checksum));

  if (value.name !== reference.name)
    throw new StorageUnavailable({ message: "Connector artifact identity mismatch", cause: null });

  return value;
};

const administrator = (principal: Principal) => {
  if (!principal.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Administrator permission is required",
    });
};

const status = async (transaction: Transaction, record: typeof connectors.$inferSelect) => {
  const selected = connectorReference.parse(record.package);
  const active = record.appliedPackage ? connectorReference.parse(record.appliedPackage) : null;
  const [job] = await transaction.select().from(jobs).where(eq(jobs.id, record.jobId));

  if (!job) throw new Error("Connector deployment job is missing");
  const result = z.object({ message: z.string() }).safeParse(job.result);

  return contract.connectorStatus.parse({
    name: record.name,
    checksum: selected.checksum,
    appliedChecksum: active?.checksum ?? null,
    secretRevision: selected.secretRevision,
    appliedSecretRevision: active?.secretRevision ?? null,
    secrets: Object.keys(selected.secrets).sort(),
    jobId: job.id,
    state: job.state,
    message: result.success ? result.data.message : null,
    entrypoints: selected.entrypoints,
  });
};

export const checkCapabilityNames = (
  metadata: z.infer<typeof contract.workerMetadata>,
  grants: z.infer<typeof contract.capabilityGrants>,
) => {
  const names = new Set([
    metadata.assets.binding,
    ...metadata.bindings.map((binding) => binding.name),
  ]);

  if (Object.keys(grants).some((name) => name.startsWith("WIDEFLEET_") || names.has(name)))
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "Connector binding collides with an app resource or reserved platform binding",
    });
};

const bindingState = (app: typeof apps.$inferSelect) =>
  contract.capabilityState.parse({
    revision: app.capabilityRevision,
    grants: app.capabilities,
    appliedRevision: app.appliedCapabilityRevision,
    error: app.capabilityError,
    state: app.capabilityError
      ? "failed"
      : !app.activeDeploymentId
        ? "saved"
        : app.appliedCapabilityRevision === app.capabilityRevision
          ? "active"
          : "pending",
  });

export const createConnectorService = (
  database: Database,
  storage: ArtifactStorage,
  encryptionKey: string,
) => ({
  setSecret: (principal: Principal, name: string, secret: string, value: string | null) =>
    transact(database, async (transaction) => {
      administrator(principal);
      const target = await defaultFleet(transaction);
      await lockFleet(transaction, target.id);

      const [existing] = await transaction
        .select()
        .from(connectors)
        .where(and(eq(connectors.fleetId, target.id), eq(connectors.name, name)));

      if (!existing)
        throw new InvalidOperation({ code: "NOT_FOUND", message: "Connector not found" });
      const reference = connectorReference.parse(existing.package);
      const secrets = new Map(Object.entries(reference.secrets));

      if (value === null) {
        secrets.delete(secret);
      } else {
        secrets.set(secret, await encryptSecret(encryptionKey, value));
      }

      const next = {
        ...reference,
        secrets: Object.fromEntries(secrets),
        secretRevision: reference.secretRevision + 1,
      };

      const id = crypto.randomUUID();
      await transaction
        .insert(jobs)
        .values({ id, fleetId: target.id, kind: "connector", connector: next });

      const [record] = await transaction
        .update(connectors)
        .set({ package: next, jobId: id })
        .where(and(eq(connectors.fleetId, target.id), eq(connectors.name, name)))
        .returning();

      if (!record) throw new Error("Connector secret update returned no row");

      return Result.ok(await status(transaction, record));
    }),
  list: (principal: Principal) =>
    transact(database, async (transaction) => {
      administrator(principal);
      const fleet = await defaultFleet(transaction);

      const records = await transaction
        .select()
        .from(connectors)
        .where(eq(connectors.fleetId, fleet.id))
        .orderBy(connectors.name);

      return Result.ok(await Promise.all(records.map((record) => status(transaction, record))));
    }),
  read: (principal: Principal, name: string) =>
    transact(database, async (transaction) => {
      administrator(principal);
      const fleet = await defaultFleet(transaction);

      const [record] = await transaction
        .select()
        .from(connectors)
        .where(and(eq(connectors.fleetId, fleet.id), eq(connectors.name, name)));

      if (!record)
        throw new InvalidOperation({ code: "NOT_FOUND", message: "Connector not found" });

      return Result.ok(await status(transaction, record));
    }),
  deploy: (principal: Principal, release: z.infer<typeof contract.connectorPackage>) =>
    transact(database, async (transaction) => {
      administrator(principal);
      const target = await defaultFleet(transaction);
      await lockFleet(transaction, target.id);

      const inventory = await transaction
        .select()
        .from(connectors)
        .where(eq(connectors.fleetId, target.id));

      const classes = release.configuration.durable_objects.bindings.map(
        (binding) => binding.class_name,
      );

      const otherClasses = inventory
        .filter((entry) => entry.name !== release.name)
        .flatMap((entry) =>
          [entry.package, entry.appliedPackage].flatMap((reference) =>
            reference ? connectorReference.parse(reference).classes : [],
          ),
        );

      if (classes.some((name) => otherClasses.includes(name)))
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "celld requires Durable Object class names to be unique within the fleet",
        });

      const resourceNames = [
        ...Object.keys(release.configuration.vars),
        ...release.configuration.d1_databases.map((binding) => binding.binding),
        ...release.configuration.r2_buckets.map((binding) => binding.binding),
        ...release.configuration.kv_namespaces.map((binding) => binding.binding),
        ...release.configuration.durable_objects.bindings.map((binding) => binding.name),
      ];

      if (
        [...resourceNames, ...release.entrypoints, ...classes].some((name) =>
          name.startsWith("WIDEFLEET_"),
        )
      )
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Platform connector names are reserved",
        });

      if (new Set(resourceNames).size !== resourceNames.length)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Connector resource binding names must be unique",
        });

      const consumers = await transaction
        .select({ capabilities: apps.capabilities })
        .from(apps)
        .where(eq(apps.fleetId, target.id));

      for (const consumer of consumers)
        for (const grant of Object.values(contract.capabilityGrants.parse(consumer.capabilities)))
          if (grant.connector === release.name && !release.entrypoints.includes(grant.entrypoint))
            throw new InvalidOperation({
              code: "CONFLICT",
              message: "Unbind existing app bindings before removing their connector entrypoint",
            });
      const checksum = await savePackage(storage, release);

      const existing = inventory.find((entry) => entry.name === release.name);
      const previous = existing ? connectorReference.parse(existing.package) : null;

      const reference = connectorReference.parse({
        secrets: previous?.secrets ?? {},
        secretRevision: previous?.secretRevision ?? 0,
        name: release.name,
        checksum,
        entrypoints: release.entrypoints,
        classes: [...new Set(classes)],
      });

      if (existing && connectorReference.parse(existing.package).checksum === checksum) {
        const current = await status(transaction, existing);

        if (current.state !== "failed") return Result.ok(current);
      }

      const id = crypto.randomUUID();
      await transaction
        .insert(jobs)
        .values({ id, fleetId: target.id, kind: "connector", connector: reference });

      const [record] = await transaction
        .insert(connectors)
        .values({ fleetId: target.id, name: release.name, package: reference, jobId: id })
        .onConflictDoUpdate({
          target: [connectors.fleetId, connectors.name],
          set: { package: reference, jobId: id },
        })
        .returning();

      if (!record) throw new Error("Connector publication returned no row");

      return Result.ok(await status(transaction, record));
    }),
  bindings: (principal: Principal, appId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      return Result.ok(bindingState(access.value));
    }),
  bind: (
    principal: Principal,
    appId: string,
    name: string,
    grant: z.infer<typeof contract.capabilityGrant> | null,
  ) =>
    transact(database, async (transaction) => {
      administrator(principal);

      const [target] = await transaction
        .select({ fleetId: apps.fleetId })
        .from(apps)
        .where(eq(apps.id, appId));

      if (!target) throw new InvalidOperation({ code: "NOT_FOUND", message: "App not found" });
      // Match claim/deploy lock order, so concurrent connector updates and grants agree.
      await lockFleet(transaction, target.fleetId);
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;
      const app = access.value;

      if (app.state === "deleting")
        throw new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" });
      const grants = contract.capabilityGrants.parse(app.capabilities);

      if (grant) {
        const [record] = await transaction
          .select()
          .from(connectors)
          .where(and(eq(connectors.fleetId, app.fleetId), eq(connectors.name, grant.connector)));

        // Failed or pending replacement code must not become a new capability.
        const active = record?.appliedPackage
          ? connectorReference.parse(record.appliedPackage)
          : null;

        if (
          !active?.entrypoints.includes(grant.entrypoint) ||
          !record ||
          !connectorReference.parse(record.package).entrypoints.includes(grant.entrypoint)
        )
          throw new InvalidOperation({
            code: "CONFLICT",
            message: "Deploy the connector entrypoint successfully before binding it",
          });
        grants[name] = grant;
      } else delete grants[name];

      const candidates = await transaction
        .select({ metadata: artifacts.metadata })
        .from(deployments)
        .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
        .where(
          and(
            eq(deployments.appId, app.id),
            or(
              inArray(deployments.status, ["queued", "running"]),
              app.activeDeploymentId ? eq(deployments.id, app.activeDeploymentId) : undefined,
            ),
          ),
        );

      for (const candidate of candidates)
        checkCapabilityNames(contract.workerMetadata.parse(candidate.metadata), grants);

      if (isDeepStrictEqual(grants, app.capabilities) && !app.capabilityError)
        return Result.ok(bindingState(app));
      const changed = !isDeepStrictEqual(grants, app.capabilities);

      const [updated] = await transaction
        .update(apps)
        .set({
          capabilities: grants,
          capabilityRevision: app.capabilityRevision + Number(changed),
          capabilityError: null,
        })
        .where(eq(apps.id, app.id))
        .returning();

      if (!updated) throw new Error("Binding update returned no row");
      await transaction.insert(jobs).values({
        id: crypto.randomUUID(),
        appId: app.id,
        fleetId: app.fleetId,
        kind: "configure",
      });

      return Result.ok(bindingState(updated));
    }),
});
