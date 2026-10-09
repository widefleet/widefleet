import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { managedApp } from "./apps.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, jobs } from "./schema.ts";
import { transact } from "./transactions.ts";

const present = (app: typeof apps.$inferSelect) =>
  contract.networkState.parse({
    revision: app.networkRevision,
    policy: app.networkPolicy,
    appliedRevision: app.appliedNetworkRevision,
    error: app.networkError,
    state: app.networkError
      ? "failed"
      : !app.activeDeploymentId
        ? "saved"
        : app.appliedNetworkRevision === app.networkRevision
          ? "active"
          : "pending",
  });

export const createNetworkService = (database: Database) => ({
  read: (principal: Principal, appId: string) =>
    transact(database, async (transaction) => {
      const app = await managedApp(transaction, principal, appId);

      if (app.isErr()) return app;

      return Result.ok(present(app.value));
    }),
  change: (principal: Principal, appId: string, input: z.infer<typeof contract.networkChange>) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;
      const app = access.value;

      if (!principal.admin && app.ownerId !== principal.id)
        return Result.err(
          new InvalidOperation({
            code: "FORBIDDEN",
            message: "Only the owner or an administrator can change network permissions",
          }),
        );

      if (app.state === "deleting")
        return Result.err(
          new InvalidOperation({ code: "CONFLICT", message: "The app is being deleted" }),
        );
      const policy = contract.networkPolicy.parse(app.networkPolicy);
      const current = policy[input.target];
      const selected = new Set(current);

      for (const origin of input.origins)
        if (input.action === "allow") selected.add(origin);
        else selected.delete(origin);

      policy[input.target] = [...selected].sort();

      const changed =
        current.length !== selected.size || current.some((origin) => !selected.has(origin));

      if (!changed && !app.networkError) return Result.ok(present(app));

      const [updated] = await transaction
        .update(apps)
        .set({
          networkPolicy: policy,
          networkRevision: app.networkRevision + Number(changed),
          networkError: null,
        })
        .where(eq(apps.id, appId))
        .returning();

      if (!updated) throw new Error("Network update returned no row");
      // Resolve the serving deployment at claim time, after earlier fleet jobs.
      // Changing permissions must never select an outdated code version.
      await transaction
        .insert(jobs)
        .values({ id: crypto.randomUUID(), appId, fleetId: app.fleetId, kind: "configure" });

      return Result.ok(present(updated));
    }),
});
