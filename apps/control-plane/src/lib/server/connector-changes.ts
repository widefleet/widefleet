import { requireAvailableHostname } from "./hostnames.ts";
import type { WorkerModule } from "./worker-modules.ts";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, isNull, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { managedApp } from "./apps.ts";
import { InvalidOperation } from "./errors.ts";
import { lockOrganizationRuntime, requireAgentExecution } from "./organization-runtime.ts";
import type { Principal } from "./identity.ts";
import {
  connectorReference,
  validateConnectorPackage,
  saveConnector,
} from "./connector-package.ts";
import {
  apps,
  artifacts,
  connectors,
  deployments,
  jobs,
  cloudflareOperations,
  organizationRuntimes,
} from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import type { Transaction } from "./transactions.ts";
import type { Configuration } from "./config.ts";

export const connectorBrowserUrl = (
  configuration: Pick<Configuration, "APP_DOMAIN" | "APP_HTTPS_PORT">,
  name: string,
  organizationSuffix: string | null,
) => {
  const origin = contract.connectorBrowserOrigin(
    name,
    organizationSuffix,
    configuration.APP_DOMAIN,
    configuration.APP_HTTPS_PORT,
  );

  return new URL("/", origin).href;
};

export const administrator = (principal: Pick<Principal, "admin">) => {
  if (!principal.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Administrator permission is required",
    });
};

export const connectorAdministrator = (principal: Pick<Principal, "application">) => {
  if (!principal.application.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Organization administrator permission is required",
    });
};

export const connectorStatus = async (
  transaction: Transaction,
  record: typeof connectors.$inferSelect,
  configuration: Pick<Configuration, "APP_DOMAIN" | "APP_HTTPS_PORT">,
) => {
  const [execution] = await transaction
    .select()
    .from(organizationRuntimes)
    .where(eq(organizationRuntimes.organizationId, record.organizationId));

  if (!execution) throw new Error("Organization runtime is missing");
  const selected = connectorReference.parse(record.package);
  const active = record.appliedPackage ? connectorReference.parse(record.appliedPackage) : null;
  const [job] = await transaction.select().from(jobs).where(eq(jobs.id, record.jobId));

  const [operation] = job
    ? []
    : await transaction
        .select()
        .from(cloudflareOperations)
        .where(eq(cloudflareOperations.id, record.jobId));

  if (!job && !operation) throw new Error("Connector deployment history is missing");
  const result = z.object({ message: z.string() }).safeParse(job?.result);

  const state =
    job?.state ?? (operation?.finishedAt ? (operation.error ? "failed" : "succeeded") : "queued");

  return contract.connectorStatus.parse({
    name: record.name,
    checksum: selected.checksum,
    appliedChecksum: active?.checksum ?? null,
    secretRevision: selected.secretRevision,
    appliedSecretRevision: active?.secretRevision ?? null,
    secrets: Object.keys(selected.secrets).sort(),
    jobId: record.jobId,
    state,
    message: result.success ? result.data.message : (operation?.error ?? null),
    entrypoints: selected.entrypoints,
    browserUrl: connectorBrowserUrl(configuration, record.name, execution.appHostnameSuffix),
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

export const prepareConnector = async (
  transaction: Transaction,
  storage: ArtifactStorage,
  execution: typeof organizationRuntimes.$inferSelect,
  release: z.infer<typeof contract.connectorPackage>,
  configuration: Pick<Configuration, "APP_DOMAIN">,
  modules?: WorkerModule[],
) => {
  await requireAvailableHostname(
    transaction,
    contract.workerHostname(release.name, execution.appHostnameSuffix, configuration.APP_DOMAIN),
    configuration.APP_DOMAIN,
    { organizationId: execution.organizationId, name: release.name },
  );

  const inventory = await transaction
    .select()
    .from(connectors)
    .where(eq(connectors.organizationId, execution.organizationId));

  const existing = inventory.find((entry) => entry.name === release.name);
  const previous = existing ? connectorReference.parse(existing.package) : null;
  validateConnectorPackage(release, Object.keys(previous?.secrets ?? {}));

  const consumers = await transaction
    .select({ capabilities: apps.capabilities, applied: apps.appliedCapabilities })
    .from(apps)
    .where(and(eq(apps.organizationId, execution.organizationId), isNull(apps.removedAt)));

  for (const consumer of consumers)
    for (const grant of [
      ...Object.values(contract.capabilityGrants.parse(consumer.capabilities)),
      ...Object.values(
        consumer.applied ? contract.capabilitySnapshot.parse(consumer.applied).grants : {},
      ),
    ])
      if (
        grant.connector === release.name &&
        !release.metadata.entrypoints.includes(grant.entrypoint)
      )
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "Unbind existing app bindings before removing their connector entrypoint",
        });

  const removesEntrypoint = inventory.some(
    (entry) =>
      entry.name === release.name &&
      [entry.package, entry.appliedPackage].some(
        (value) =>
          value &&
          connectorReference
            .parse(value)
            .entrypoints.some((name) => !release.metadata.entrypoints.includes(name)),
      ),
  );

  if (execution.executor === "cloudflare" && removesEntrypoint) {
    // An activation can publish grants before its SQL receipt commits. Keep those
    // grants protected until a later confirmed revision proves their revocation.
    const unconfirmed = await transaction
      .select({ result: cloudflareOperations.result })
      .from(cloudflareOperations)
      .innerJoin(apps, eq(apps.id, cloudflareOperations.appId))
      .where(
        and(
          eq(apps.organizationId, execution.organizationId),
          sql`${cloudflareOperations.command}->>'kind' = 'capabilities'`,
          sql`(${cloudflareOperations.result}->>'revision')::integer > COALESCE(${apps.appliedCapabilityRevision}, -1)`,
        ),
      );

    for (const operation of unconfirmed)
      for (const grant of Object.values(contract.capabilityState.parse(operation.result).grants))
        if (
          grant.connector === release.name &&
          !release.metadata.entrypoints.includes(grant.entrypoint)
        )
          throw new InvalidOperation({
            code: "CONFLICT",
            message:
              "Confirm pending app binding changes before removing their connector entrypoint",
          });
  }

  const checksum = await saveConnector(storage, execution.organizationId, release, modules);

  const reference = connectorReference.parse({
    secrets: previous?.secrets ?? {},
    secretRevision: previous?.secretRevision ?? 0,
    name: release.name,
    checksum,
    entrypoints: release.metadata.entrypoints,
    classes: [...new Set(release.metadata.durable_objects.map((binding) => binding.class_name))],
  });

  return { reference, existing };
};

export const validateCapabilityChange = async (
  transaction: Transaction,
  principal: Pick<Principal, "id" | "admin" | "application">,
  appId: string,
  name: string,
  grant: z.infer<typeof contract.capabilityGrant> | null,
  enqueue: boolean,
) => {
  connectorAdministrator(principal);

  const [target] = await transaction
    .select({ organizationId: apps.organizationId })
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.organizationId, principal.application.organizationId)));

  if (!target) throw new InvalidOperation({ code: "NOT_FOUND", message: "App not found" });
  // Match claim/deploy lock order, so concurrent connector updates and grants agree.
  await lockOrganizationRuntime(transaction, principal.application.organizationId);

  if (enqueue) await requireAgentExecution(transaction, target.organizationId, "Connectors");
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
      .where(
        and(
          eq(connectors.organizationId, app.organizationId),
          eq(connectors.name, grant.connector),
        ),
      );

    // Failed or pending replacement code must not become a new capability.
    const active = record?.appliedPackage ? connectorReference.parse(record.appliedPackage) : null;

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
