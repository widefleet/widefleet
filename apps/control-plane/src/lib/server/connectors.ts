import { operationId } from "./deployment-execution.ts";
import type { WorkerModule } from "./worker-modules.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import {
  connectorAdministrator,
  connectorStatus,
  connectorBrowserUrl,
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
import { lockOrganizationRuntime, requireAgentExecution } from "./organization-runtime.ts";
import type { Principal } from "./identity.ts";
import {
  connectorReference,
  connectorChecksum,
  loadConnector,
  validateConnectorPackage,
  validateConnectorSecret,
} from "./connector-package.ts";
import { artifacts, connectors, deployments, jobs } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact, type Transaction } from "./transactions.ts";
import type { Configuration } from "./config.ts";

export { checkCapabilityNames } from "./connector-changes.ts";

const presentStatus = async (
  transaction: Transaction,
  record: typeof connectors.$inferSelect,
  configuration: Pick<Configuration, "APP_DOMAIN" | "APP_HTTPS_PORT">,
  execution?: HostedExecution,
) => {
  const current = await connectorStatus(transaction, record, configuration);

  return execution ? execution.connectors.status(current) : current;
};

export const createConnectorService = (
  database: Database,
  storage: ArtifactStorage,
  encryptionKey: string,
  configuration: Pick<Configuration, "APP_DOMAIN" | "APP_HTTPS_PORT">,
  execution?: HostedExecution,
) => ({
  catalog: (principal: Principal) =>
    transact(database, async (transaction) => {
      const records = await transaction
        .select()
        .from(connectors)
        .where(eq(connectors.organizationId, principal.application.organizationId))
        .orderBy(connectors.name);

      return Result.ok(
        await Promise.all(
          records.map(async (record) => {
            const desired = connectorReference.parse(record.package);

            const active = record.appliedPackage
              ? connectorReference.parse(record.appliedPackage)
              : null;

            // Offer only entrypoints that the binding operation can currently grant.
            return contract.connectorCatalogEntry.parse({
              name: record.name,
              browserUrl: active
                ? await connectorBrowserUrl(configuration, record.organizationId, record.name)
                : null,
              entrypoints:
                active?.entrypoints.filter((name) => desired.entrypoints.includes(name)) ?? [],
            });
          }),
        ),
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
          connectorAdministrator(principal);

          if (value !== null) validateConnectorSecret(value);

          const target = await lockOrganizationRuntime(
            transaction,
            principal.application.organizationId,
          );

          await requireAgentExecution(transaction, target.organizationId, "Connectors");

          const [existing] = await transaction
            .select()
            .from(connectors)
            .where(
              and(eq(connectors.organizationId, target.organizationId), eq(connectors.name, name)),
            );

          if (!existing)
            throw new InvalidOperation({ code: "NOT_FOUND", message: "Connector not found" });
          const reference = connectorReference.parse(existing.package);
          const secrets = new Map(Object.entries(reference.secrets));

          if (value === null) {
            secrets.delete(secret);
          } else {
            secrets.set(secret, await encryptSecret(encryptionKey, value));
          }

          validateConnectorPackage(await loadConnector(storage, reference), [...secrets.keys()]);

          const next = {
            ...reference,
            secrets: Object.fromEntries(secrets),
            secretRevision: reference.secretRevision + 1,
          };

          const id = crypto.randomUUID();
          await transaction.insert(jobs).values({
            id,
            organizationId: target.organizationId,
            kind: "connector",
            connector: next,
          });

          const [record] = await transaction
            .update(connectors)
            .set({ package: next, jobId: id })
            .where(
              and(eq(connectors.organizationId, target.organizationId), eq(connectors.name, name)),
            )
            .returning();

          if (!record) throw new Error("Connector secret update returned no row");

          return Result.ok(await presentStatus(transaction, record, configuration, execution));
        }),
  list: (principal: Principal) =>
    transact(database, async (transaction) => {
      connectorAdministrator(principal);

      const records = await transaction
        .select()
        .from(connectors)
        .where(eq(connectors.organizationId, principal.application.organizationId))
        .orderBy(connectors.name);

      return Result.ok(
        await Promise.all(
          records.map((record) => presentStatus(transaction, record, configuration, execution)),
        ),
      );
    }),
  read: (principal: Principal, name: string) =>
    transact(database, async (transaction) => {
      connectorAdministrator(principal);

      const [record] = await transaction
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.organizationId, principal.application.organizationId),
            eq(connectors.name, name),
          ),
        );

      if (!record)
        throw new InvalidOperation({ code: "NOT_FOUND", message: "Connector not found" });

      return Result.ok(await presentStatus(transaction, record, configuration, execution));
    }),
  deploy: (
    principal: Principal,
    release: z.infer<typeof contract.connectorPackage>,
    modules: WorkerModule[],
    requestId: string,
  ) =>
    execution
      ? execution.connectors.deploy(principal, release, modules, requestId)
      : transact(database, async (transaction) => {
          connectorAdministrator(principal);

          const target = await lockOrganizationRuntime(
            transaction,
            principal.application.organizationId,
          );

          await requireAgentExecution(transaction, target.organizationId, "Connectors");

          const id = operationId(`connectors/${target.organizationId}/${release.name}`, requestId);
          const [previous] = await transaction.select().from(jobs).where(eq(jobs.id, id));

          if (previous) {
            const original = connectorReference.parse(previous.connector);

            const [existing] = await transaction
              .select()
              .from(connectors)
              .where(
                and(
                  eq(connectors.organizationId, target.organizationId),
                  eq(connectors.name, release.name),
                ),
              );

            const checksum = connectorChecksum(target.organizationId, release);

            if (original.checksum !== checksum || previous.kind !== "connector" || !existing)
              throw new InvalidOperation({
                code: "CONFLICT",
                message: "The request ID already refers to another artifact",
              });

            return Result.ok(
              await presentStatus(
                transaction,
                { ...existing, package: original, jobId: id },
                configuration,
                execution,
              ),
            );
          }

          const { reference } = await prepareConnector(
            transaction,
            storage,
            target,
            release,
            modules,
          );

          await transaction.insert(jobs).values({
            id,
            organizationId: target.organizationId,
            kind: "connector",
            connector: reference,
          });

          const [record] = await transaction
            .insert(connectors)
            .values({
              organizationId: target.organizationId,
              name: release.name,
              package: reference,
              jobId: id,
            })
            .onConflictDoUpdate({
              target: [connectors.organizationId, connectors.name],
              set: { package: reference, jobId: id },
            })
            .returning();

          if (!record) throw new Error("Connector publication returned no row");

          return Result.ok(await presentStatus(transaction, record, configuration, execution));
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
