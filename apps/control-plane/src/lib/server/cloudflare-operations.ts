import { applyCapabilityChange } from "./connector-changes.ts";
import { lockFleet } from "./fleets.ts";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { applyAccessChange } from "./app-access.ts";
import { presentDeployment } from "./apps.ts";
import type { Database } from "./database.ts";
import { deploymentCommand } from "./deployment-execution.ts";
import { InvalidOperation } from "./errors.ts";
import { applyNetworkChange } from "./network.ts";
import { ensureFleetRuntime, runtimeReference } from "./runtime-releases.ts";
import {
  apps,
  artifacts,
  cloudflareOperations,
  deploymentEvents,
  deployments,
  fleets,
} from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

export const operationTarget = z.object({
  appId: z.uuid(),
  runtime: runtimeReference,
  accessRevision: z.number().int().nonnegative(),
  networkRevision: z.number().int().nonnegative(),
  capabilityRevision: z.number().int().nonnegative().default(0),
});

// Called only after Workflows has durably accepted the command. The request can materialize
// this history immediately; the Workflow repeats it safely if the request disconnects.
export const registerCloudflareOperation = (
  database: Database,
  storage: ArtifactStorage,
  command: z.infer<typeof deploymentCommand>,
) =>
  transact(database, (transaction) =>
    Result.gen(async function* () {
      const [scope] = await transaction
        .select({ fleetId: apps.fleetId })
        .from(apps)
        .where(eq(apps.id, command.appId));

      if (scope) await lockFleet(transaction, scope.fleetId);

      const [app] = await transaction
        .select()
        .from(apps)
        .where(eq(apps.id, command.appId))
        .for("update");

      if (!app || app.state === "deleting")
        return yield* new InvalidOperation({
          code: "CONFLICT",
          message: "The app is no longer available for deployment",
        });

      const [existing] = await transaction
        .select()
        .from(cloudflareOperations)
        .where(eq(cloudflareOperations.id, command.id));

      if (existing) return Result.ok(existing);

      const [fleet] = await transaction.select().from(fleets).where(eq(fleets.id, app.fleetId));

      if (!fleet || fleet.executor !== "cloudflare")
        return yield* new InvalidOperation({
          code: "CONFLICT",
          message: "This installation does not use Cloudflare execution",
        });

      let targetIds = [app.id];

      let result:
        | z.infer<typeof contract.deployment>
        | z.infer<typeof contract.networkState>
        | z.infer<typeof contract.appAccessState>
        | z.infer<typeof contract.capabilityState>;

      if (command.kind === "deploy") {
        const [artifact] = await transaction
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.id, command.artifactId), eq(artifacts.appId, app.id)));

        if (!artifact)
          return yield* new InvalidOperation({
            code: "NOT_FOUND",
            message: "Deployment artifact not found",
          });

        contract.artifact.parse({
          id: artifact.id,
          appId: artifact.appId,
          metadata: artifact.metadata,
          manifest: artifact.manifest,
          modules: artifact.modules,
        });
        await transaction
          .insert(deployments)
          .values({
            id: command.id,
            appId: app.id,
            artifactId: command.artifactId,
            requestId: command.requestId,
            createdAt: new Date(command.createdAt),
          })
          .onConflictDoNothing();

        const [deployment] = await transaction
          .select()
          .from(deployments)
          .where(and(eq(deployments.appId, app.id), eq(deployments.requestId, command.requestId)));

        if (
          !deployment ||
          deployment.id !== command.id ||
          deployment.artifactId !== command.artifactId
        )
          return yield* new InvalidOperation({
            code: "CONFLICT",
            message: "The request ID already refers to another deployment",
          });

        result = presentDeployment(deployment);
        await transaction.insert(deploymentEvents).values({
          deploymentId: deployment.id,
          level: "info",
          message: "Cloudflare accepted deployment",
        });
      } else if (command.kind === "network") {
        result = yield* Result.await(
          applyNetworkChange(transaction, command.actor, app.id, command.input, false),
        );
      } else if (command.kind === "capabilities") {
        result = yield* Result.await(
          applyCapabilityChange(
            transaction,
            command.actor,
            app.id,
            command.name,
            command.grant,
            false,
          ),
        );
      } else {
        const access = yield* Result.await(
          applyAccessChange(transaction, command.actor, app.id, command.input, false),
        );

        result = access;
        targetIds = [app.id, ...access.previews.map((preview) => preview.appId)];
      }

      const runtime = fleet.appliedRuntime
        ? runtimeReference.parse(fleet.appliedRuntime)
        : await ensureFleetRuntime(transaction, storage, fleet.id);

      const targets: z.infer<typeof operationTarget>[] = [];

      for (const appId of targetIds) {
        const [target] = await transaction.select().from(apps).where(eq(apps.id, appId));

        if (!target) throw new Error("Deployment target disappeared while registering the command");

        targets.push({
          appId,
          runtime,
          accessRevision: target.accessRevision,
          networkRevision: target.networkRevision,
          capabilityRevision: target.capabilityRevision,
        });
      }

      const [record] = await transaction
        .insert(cloudflareOperations)
        .values({
          id: command.id,
          appId: app.id,
          command,
          targets,
          result,
          createdAt: new Date(command.createdAt),
        })
        .returning();

      if (!record) throw new Error("Cloudflare operation history returned no record");

      return Result.ok(record);
    }),
  );
