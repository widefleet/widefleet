import { transact } from "./transactions.ts";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { managedApp } from "./apps.ts";
import { bindingState, applyCapabilityChange } from "./capability-changes.ts";
import { serviceEntrypoints } from "./app-services.ts";
import { apps, artifacts, deployments, jobs } from "./schema.ts";
import type { Database } from "./database.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import type { Principal } from "./identity.ts";

export const createConnectionService = (database: Database, execution?: HostedExecution) => ({
  services: (principal: Principal) =>
    transact(database, async (transaction) => {
      const records = await transaction
        .select()
        .from(apps)
        .where(
          and(
            eq(apps.organizationId, principal.application.organizationId),
            isNull(apps.removedAt),
          ),
        )
        .orderBy(apps.slug);

      const entries = await Promise.all(
        records.map(async (app) => ({
          appId: app.id,
          slug: app.slug,
          displayName: app.displayName,
          entrypoints: await serviceEntrypoints(transaction, app),
        })),
      );

      return Result.ok(entries.filter((entry) => entry.entrypoints.length > 0));
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
          connections: desired,
          activeConnections: active,
        }),
      );
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
      ? execution.connections.bind(principal, appId, name, grant)
      : transact(database, (transaction) =>
          applyCapabilityChange(transaction, principal, appId, name, grant, true),
        ),
});
