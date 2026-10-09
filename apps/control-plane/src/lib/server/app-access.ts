import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import { lockAppDescendants, managedApp } from "./apps.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, jobs } from "./schema.ts";
import { transact, type Transaction } from "./transactions.ts";

// Include legacy descendants too. New previews can only belong to original apps.
const descendants = (appId: string) => sql`${apps.id} in (
  with recursive previews as (
    select id from app where parent_id = ${appId}
    union
    select app.id from app join previews on app.parent_id = previews.id
  ) select id from previews
)`;

const status = (app: typeof apps.$inferSelect) =>
  contract.appAccessStatus.parse({
    revision: app.accessRevision,
    groups: app.accessGroups,
    appliedRevision: app.appliedAccessRevision,
    state: app.accessError
      ? "failed"
      : !app.activeDeploymentId
        ? "saved"
        : app.appliedAccessRevision === app.accessRevision
          ? "active"
          : "pending",
    error: app.accessError,
  });

const present = async (
  transaction: Transaction,
  principal: Principal,
  app: typeof apps.$inferSelect,
) => {
  const previews = app.parentId
    ? []
    : await transaction
        .select()
        .from(apps)
        .where(and(descendants(app.id), ne(apps.state, "deleting")))
        .orderBy(apps.hostname);

  return contract.appAccessState.parse({
    ...status(app),
    inheritedFrom: app.parentId,
    canManage: app.parentId === null && (principal.admin || app.ownerId === principal.id),
    previews: previews.map((preview) => ({
      ...status(preview),
      appId: preview.id,
      hostname: preview.hostname,
    })),
  });
};

export const createAppAccessService = (database: Database) => ({
  read: (principal: Principal, appId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      return Result.ok(await present(transaction, principal, access.value));
    }),
  change: (principal: Principal, appId: string, input: z.infer<typeof contract.appAccessChange>) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;
      const app = access.value;

      if (app.parentId !== null || (!principal.admin && app.ownerId !== principal.id))
        return Result.err(
          new InvalidOperation({
            code: "FORBIDDEN",
            message:
              "Only the original app's owner or an administrator can change its access rules",
          }),
        );

      if (app.state === "deleting")
        return Result.err(
          new InvalidOperation({ code: "CONFLICT", message: "The app is being deleted" }),
        );

      if (input.revision !== app.accessRevision)
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "Access rules have changed. Reload them before saving again.",
          }),
        );

      const groups = contract.appAccessGroups.parse(input.groups).sort();

      const current = contract.appAccessGroups.parse(app.accessGroups).sort();

      const changed = JSON.stringify(groups) !== JSON.stringify(current);
      const revision = app.accessRevision + Number(changed);

      const [updated] = await transaction
        .update(apps)
        .set({
          accessGroups: groups,
          accessRevision: revision,
          accessError: null,
        })
        .where(eq(apps.id, app.id))
        .returning();

      if (!updated) throw new Error("Access update returned no app");

      // Materialize inheritance atomically. Creation locks the parent before
      // copying these values, so a concurrent preview cannot miss an update.
      await lockAppDescendants(transaction, app.id);

      const previews = await transaction
        .update(apps)
        .set({
          accessGroups: groups,
          accessRevision: revision,
          accessError: null,
        })
        .where(and(descendants(app.id), ne(apps.state, "deleting")))
        .returning();

      for (const target of [updated, ...previews]) {
        if (!changed && target.appliedAccessRevision === revision) continue;
        await transaction.insert(jobs).values({
          id: crypto.randomUUID(),
          appId: target.id,
          fleetId: target.fleetId,
          kind: "configure",
        });
      }

      return Result.ok(await present(transaction, principal, updated));
    }),
});
