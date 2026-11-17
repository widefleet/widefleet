import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { serviceEntrypoints } from "./app-services.ts";
import { organizationAdministrator } from "./capability-changes.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { lockOrganizationRuntime } from "./organization-runtime.ts";
import { apps, jobs } from "./schema.ts";
import type { Transaction } from "./transactions.ts";

export const serviceAccessState = (app: typeof apps.$inferSelect) =>
  contract.serviceGrantsState.parse({
    mode: app.serviceAccessMode,
    grants: app.serviceGrants,
    revision: app.serviceAccessRevision,
    appliedRevision: app.appliedServiceAccessRevision,
    state: app.serviceAccessError
      ? "failed"
      : !app.activeDeploymentId
        ? "saved"
        : app.appliedServiceAccessRevision === app.serviceAccessRevision
          ? "active"
          : "pending",
    error: app.serviceAccessError,
  });

export const serviceAccessApp = async (
  transaction: Transaction,
  principal: Pick<Principal, "id" | "admin" | "application">,
  appId: string,
) => {
  organizationAdministrator(principal);
  await lockOrganizationRuntime(transaction, principal.application.organizationId);

  const [app] = await transaction
    .select()
    .from(apps)
    .where(
      and(
        eq(apps.id, appId),
        eq(apps.organizationId, principal.application.organizationId),
        isNull(apps.removedAt),
      ),
    )
    .for("update");

  if (!app || app.state === "deleting")
    throw new InvalidOperation({ code: "NOT_FOUND", message: "Service not found" });

  return app;
};

export const validateServiceAccessChange = async (
  transaction: Transaction,
  principal: Pick<Principal, "id" | "admin" | "application">,
  appId: string,
  input: z.infer<typeof contract.serviceAccessUpdate>,
) => {
  const app = await serviceAccessApp(transaction, principal, appId);

  if (input.revision !== undefined && input.revision !== app.serviceAccessRevision)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "Service access changed. Reload before saving.",
    });

  if (input.grants) {
    const entrypoints = await serviceEntrypoints(transaction, app);
    const saved = contract.serviceGrants.parse(app.serviceGrants);

    if (
      input.grants.some((grant) => {
        if (entrypoints.includes(grant.entrypoint)) return false;
        const previous = saved.find((entry) => entry.entrypoint === grant.entrypoint);

        // A deployment may remove an entrypoint. Keep its saved rules editable for
        // revocation, while requiring publication before granting any new access.
        return (
          !previous ||
          grant.users.some(
            (user) =>
              !previous.users.some(
                (entry) => entry.issuer === user.issuer && entry.subject === user.subject,
              ),
          ) ||
          grant.groups.some((group) => !previous.groups.includes(group))
        );
      })
    )
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Access rules must name published service entrypoints",
      });
  }

  return Result.ok(app);
};

export const applyServiceAccessChange = async (
  transaction: Transaction,
  principal: Pick<Principal, "id" | "admin" | "application">,
  appId: string,
  input: z.infer<typeof contract.serviceAccessUpdate>,
  enqueue = true,
) => {
  const valid = await validateServiceAccessChange(transaction, principal, appId, input);

  if (valid.isErr()) return valid;
  const app = valid.value;
  const grants = input.grants ?? contract.serviceGrants.parse(app.serviceGrants);
  const mode = input.mode ?? app.serviceAccessMode;
  const changed = mode !== app.serviceAccessMode || !isDeepStrictEqual(grants, app.serviceGrants);

  const [updated] = await transaction
    .update(apps)
    .set({
      serviceAccessMode: mode,
      serviceGrants: grants,
      serviceAccessRevision: app.serviceAccessRevision + Number(changed),
      serviceAccessError: null,
    })
    .where(eq(apps.id, appId))
    .returning();

  if (!updated) throw new Error("Service access update returned no app");

  if (enqueue && updated.appliedServiceAccessRevision !== updated.serviceAccessRevision)
    await transaction.insert(jobs).values({
      id: crypto.randomUUID(),
      appId,
      organizationId: app.organizationId,
      kind: "configure",
    });

  return Result.ok(serviceAccessState(updated));
};
