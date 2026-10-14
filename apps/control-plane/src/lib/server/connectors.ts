import type { HostedExecution } from "./deployment-execution.ts";
import {
  administrator,
  connectorStatus,
  bindingState,
  prepareConnector,
  applyCapabilityChange,
} from "./connector-changes.ts";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { managedApp } from "./apps.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { encryptSecret } from "./secret-encryption.ts";
import { defaultFleet, lockFleet, requireAgentExecution } from "./fleets.ts";
import type { Principal } from "./identity.ts";
import { connectorReference } from "./connector-package.ts";
import { artifacts, connectors, deployments, jobs } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact, type Transaction } from "./transactions.ts";

export { checkCapabilityNames } from "./connector-changes.ts";

const presentStatus = async (
  transaction: Transaction,
  record: typeof connectors.$inferSelect,
  execution?: HostedExecution,
) => {
  const current = await connectorStatus(transaction, record);

  return execution ? execution.connectors.status(current) : current;
};

export const createConnectorService = (
  database: Database,
  storage: ArtifactStorage,
  encryptionKey: string,
  execution?: HostedExecution,
) => ({
  catalog: () =>
    transact(database, async (transaction) => {
      const fleet = await defaultFleet(transaction);

      const records = await transaction
        .select()
        .from(connectors)
        .where(eq(connectors.fleetId, fleet.id))
        .orderBy(connectors.name);

      return Result.ok(
        records.map((record) => {
          const desired = connectorReference.parse(record.package);

          const active = record.appliedPackage
            ? connectorReference.parse(record.appliedPackage)
            : null;

          // Offer only entrypoints that the binding operation can currently grant.
          return contract.connectorCatalogEntry.parse({
            name: record.name,
            entrypoints:
              active?.entrypoints.filter((name) => desired.entrypoints.includes(name)) ?? [],
          });
        }),
      );
    }),
  connections: (principal: Principal, appId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;
      const app = access.value;

      const [deployed] = app.activeDeploymentId
        ? await transaction
            .select({ metadata: artifacts.metadata })
            .from(deployments)
            .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
            .where(and(eq(deployments.appId, app.id), eq(deployments.id, app.activeDeploymentId)))
        : [];

      const metadata = deployed ? contract.workerMetadata.parse(deployed.metadata) : null;

      const resources =
        metadata?.bindings.flatMap<z.infer<typeof contract.appResource>>((binding) => {
          switch (binding.type) {
            case "plain_text":
              return [];
            case "d1":
              return [
                {
                  binding: binding.name,
                  type: binding.type,
                  target: binding.database_name,
                  databaseId: binding.database_id ?? binding.database_name,
                },
              ];
            case "r2_bucket":
              return [{ binding: binding.name, type: binding.type, target: binding.bucket_name }];
            case "kv_namespace":
              return [{ binding: binding.name, type: binding.type, target: binding.id }];
            case "queue":
              return [{ binding: binding.name, type: binding.type, target: binding.queue }];
            case "workflow":
              return [{ binding: binding.name, type: binding.type, target: binding.workflow_name }];
          }
        }) ?? [];

      const desired = bindingState(app);
      let active = app.activeDeploymentId ? null : contract.capabilityGrants.parse({});

      if (app.activeDeploymentId && app.appliedCapabilityRevision === app.capabilityRevision) {
        active = desired.grants;
      } else if (app.activeDeploymentId && app.appliedCapabilities) {
        active = contract.capabilitySnapshot.parse(app.appliedCapabilities).grants;
      } else if (app.activeDeploymentId && app.appliedCapabilityRevision !== null) {
        // Successful job snapshots retain the serving grants after a pending or failed edit.
        const [applied] = await transaction
          .select({ capabilities: jobs.capabilities })
          .from(jobs)
          .where(
            and(
              eq(jobs.appId, app.id),
              eq(jobs.deploymentId, app.activeDeploymentId),
              eq(jobs.state, "succeeded"),
              sql`${jobs.capabilities}->>'revision' = ${String(app.appliedCapabilityRevision)}`,
            ),
          )
          .orderBy(desc(jobs.sequence))
          .limit(1);

        if (applied) active = contract.capabilitySnapshot.parse(applied.capabilities).grants;
      }

      return Result.ok(
        contract.appConnections.parse({
          deploymentId: app.activeDeploymentId,
          resources: metadata
            ? [...resources, { binding: metadata.assets.binding, type: "assets", target: app.slug }]
            : resources,
          connectors: desired,
          activeConnectors: active,
        }),
      );
    }),
  setSecret: (principal: Principal, name: string, secret: string, value: string | null) =>
    execution
      ? execution.connectors.setSecret(principal, name, secret, value)
      : transact(database, async (transaction) => {
          administrator(principal);
          const target = await defaultFleet(transaction);
          await lockFleet(transaction, target.id);
          await requireAgentExecution(transaction, target.id, "Connectors");

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

          return Result.ok(await presentStatus(transaction, record, execution));
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

      return Result.ok(
        await Promise.all(records.map((record) => presentStatus(transaction, record, execution))),
      );
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

      return Result.ok(await presentStatus(transaction, record, execution));
    }),
  deploy: (principal: Principal, release: z.infer<typeof contract.connectorPackage>) =>
    execution
      ? execution.connectors.deploy(principal, release)
      : transact(database, async (transaction) => {
          administrator(principal);
          const target = await defaultFleet(transaction);
          await lockFleet(transaction, target.id);
          await requireAgentExecution(transaction, target.id, "Connectors");

          const { reference, existing } = await prepareConnector(
            transaction,
            storage,
            target,
            release,
          );

          const checksum = reference.checksum;

          if (existing && connectorReference.parse(existing.package).checksum === checksum) {
            const current = await presentStatus(transaction, existing, execution);

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

          return Result.ok(await presentStatus(transaction, record, execution));
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
    execution
      ? execution.connectors.bind(principal, appId, name, grant)
      : transact(database, (transaction) =>
          applyCapabilityChange(transaction, principal, appId, name, grant, true),
        ),
});
