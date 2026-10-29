import { resolveAppService, checkServiceCycle } from "./app-services.ts";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, inArray, or } from "drizzle-orm";
import type { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { managedApp } from "./apps.ts";
import { InvalidOperation } from "./errors.ts";
import { lockOrganizationRuntime, requireAgentExecution } from "./organization-runtime.ts";
import type { Principal } from "./identity.ts";
import { apps, artifacts, deployments, jobs } from "./schema.ts";
import type { Transaction } from "./transactions.ts";

export const administrator = (principal: Pick<Principal, "admin">) => {
  if (!principal.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Administrator permission is required",
    });
};

export const organizationAdministrator = (principal: Pick<Principal, "application">) => {
  if (!principal.application.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Organization administrator permission is required",
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
      message: "App binding collides with an app resource or reserved platform binding",
    });
};

export const bindingState = (app: typeof apps.$inferSelect) =>
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

export const validateCapabilityChange = async (
  transaction: Transaction,
  principal: Pick<Principal, "id" | "admin" | "application">,
  appId: string,
  name: string,
  grant: z.infer<typeof contract.capabilityGrant> | null,
  enqueue: boolean,
) => {
  organizationAdministrator(principal);

  const [target] = await transaction
    .select({ organizationId: apps.organizationId })
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.organizationId, principal.application.organizationId)));

  if (!target) throw new InvalidOperation({ code: "NOT_FOUND", message: "App not found" });
  // Match claim/deploy lock order, so concurrent app updates and grants agree.
  await lockOrganizationRuntime(transaction, principal.application.organizationId);

  if (enqueue) await requireAgentExecution(transaction, target.organizationId, "App connections");
  const access = await managedApp(transaction, principal, appId);

  if (access.isErr()) return access;
  const app = access.value;

  if (app.state === "deleting")
    throw new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" });
  const grants = contract.capabilityGrants.parse(app.capabilities);

  if (grant?.app) {
    await resolveAppService(transaction, app.organizationId, grant);
    await checkServiceCycle(transaction, app.organizationId, app.id, grant.app);
    grants[name] = { app: grant.app, entrypoint: grant.entrypoint };
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

  return Result.ok({ app, grants });
};

export const applyCapabilityChange = async (
  transaction: Transaction,
  principal: Pick<Principal, "id" | "admin" | "application">,
  appId: string,
  name: string,
  grant: z.infer<typeof contract.capabilityGrant> | null,
  enqueue: boolean,
) => {
  const valid = await validateCapabilityChange(transaction, principal, appId, name, grant, enqueue);

  if (valid.isErr()) return valid;
  const { app, grants } = valid.value;

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

  if (enqueue)
    await transaction.insert(jobs).values({
      id: crypto.randomUUID(),
      appId: app.id,
      organizationId: app.organizationId,
      kind: "configure",
    });

  return Result.ok(bindingState(updated));
};
