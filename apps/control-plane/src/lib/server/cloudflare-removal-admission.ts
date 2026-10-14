import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { managedApp, lockAppDescendants } from "./apps.ts";
import { lockFleet } from "./fleets.ts";
import { apps, cloudflareOperations, fleets } from "./schema.ts";
import { transact } from "./transactions.ts";
import type { Database } from "./database.ts";
import type { Principal } from "./identity.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { cloudflareRemovalCommand, removalTarget } from "./cloudflare-removal-command.ts";
import { cloudflareAppOperation } from "./cloudflare-app-operation-command.ts";
import { acceptCloudflareWorkflow } from "./cloudflare-admission.ts";
import { hostedDeploymentId } from "./deployment-execution.ts";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";

export const registerCloudflareRemoval = (
  database: Database,
  command: z.infer<typeof cloudflareRemovalCommand>,
) =>
  transact(database, async (transaction) => {
    const [scope] = await transaction
      .select({ fleetId: apps.fleetId })
      .from(apps)
      .where(eq(apps.id, command.appId));

    if (scope) await lockFleet(transaction, scope.fleetId);
    const access = await managedApp(transaction, command.actor, command.appId);

    if (access.isErr()) return access;

    const [fleet] = await transaction
      .select()
      .from(fleets)
      .where(eq(fleets.id, access.value.fleetId));

    if (fleet?.executor !== "cloudflare")
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "This installation does not use Cloudflare execution",
      });

    const [existing] = await transaction
      .select()
      .from(cloudflareOperations)
      .where(eq(cloudflareOperations.id, command.id));

    if (existing) {
      const stored = cloudflareRemovalCommand.parse(existing.command);

      if (stored.appId !== command.appId)
        throw new InvalidOperation({ code: "CONFLICT", message: "Removal belongs to another app" });

      return Result.ok(z.array(removalTarget).parse(existing.targets));
    }

    const descendants = await lockAppDescendants(transaction, command.appId);

    const targets = [access.value, ...descendants]
      .toReversed()
      .map(({ id, hostname }) => ({ id, hostname }));

    if (descendants.some((app) => app.fleetId !== fleet.id))
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "App previews belong to another fleet",
      });

    await transaction
      .update(apps)
      .set({ state: "deleting" })
      .where(
        inArray(
          apps.id,
          targets.map((app) => app.id),
        ),
      );
    await transaction.insert(cloudflareOperations).values({
      id: command.id,
      appId: command.appId,
      command,
      targets,
      result: { accepted: true },
      createdAt: new Date(command.createdAt),
    });

    return Result.ok(targets);
  });

export const createCloudflareRemoval =
  (bindings: CloudflareBindings, database: Database) => (principal: Principal, appId: string) =>
    Result.tryPromise({
      try: async () => {
        // Authorization precedes both reading immutable inputs and native Workflow admission.
        (
          await transact(database, async (transaction) => {
            const access = await managedApp(transaction, principal, appId);

            if (access.isErr()) return access;

            const [fleet] = await transaction
              .select()
              .from(fleets)
              .where(eq(fleets.id, access.value.fleetId));

            if (fleet?.executor !== "cloudflare")
              throw new InvalidOperation({
                code: "CONFLICT",
                message: "This installation does not use Cloudflare execution",
              });

            return Result.ok(undefined);
          })
        ).unwrap();

        const workflow = bindings.APP_OPERATIONS;

        if (!workflow) throw new Error("App operation Workflow binding is missing");
        const id = hostedDeploymentId(appId, "remove-app");
        const previous = await bindings.ARTIFACTS.get(`apps/${appId}/commands/${id}.json`);

        const requested = previous
          ? cloudflareRemovalCommand.parse(await previous.json())
          : {
              id,
              appId,
              kind: "remove" as const,
              actor: { id: principal.id, admin: principal.admin },
              createdAt: new Date().toISOString(),
            };

        if (requested.id !== id || requested.appId !== appId)
          throw new Error("Invalid removal command");

        const command = cloudflareRemovalCommand.parse(
          await acceptCloudflareWorkflow(
            bindings.ARTIFACTS,
            workflow,
            requested,
            cloudflareAppOperation,
          ),
        );

        const registered = await registerCloudflareRemoval(database, command);

        // The accepted Workflow may have completed before the API materializes its history.
        if (
          registered.isErr() &&
          !(registered.error instanceof InvalidOperation && registered.error.code === "NOT_FOUND")
        )
          throw registered.error;

        return { accepted: true };
      },
      catch: (cause) =>
        cause instanceof InvalidOperation || cause instanceof DatabaseUnavailable
          ? cause
          : new StorageUnavailable({ message: "Cloudflare could not accept app removal", cause }),
    });
