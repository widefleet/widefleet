import * as contract from "@platform/contracts";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Transaction } from "./transactions.ts";
import { apps, artifacts, deployments, cloudflareOperations, jobs } from "./schema.ts";
import { InvalidOperation } from "./errors.ts";

const conflict = (message: string) => new InvalidOperation({ code: "CONFLICT", message });

// Include saved, confirmed and potentially published grants. SQL confirmation can
// lag serving state after a lost activation response.
export const serviceConsumers = async (transaction: Transaction, organizationId: string) => {
  const records = await transaction
    .select()
    .from(apps)
    .where(and(eq(apps.organizationId, organizationId), isNull(apps.removedAt)));

  const pending = await transaction
    .select({ appId: cloudflareOperations.appId, result: cloudflareOperations.result })
    .from(cloudflareOperations)
    .innerJoin(apps, eq(apps.id, cloudflareOperations.appId))
    .where(
      and(
        eq(apps.organizationId, organizationId),
        sql`${cloudflareOperations.command}->>'kind' = 'capabilities'`,
        sql`(${cloudflareOperations.result}->>'revision')::integer > COALESCE(${apps.appliedCapabilityRevision}, -1)`,
      ),
    );

  const agentSnapshots = await transaction
    .select({ appId: jobs.appId, capabilities: jobs.capabilities })
    .from(jobs)
    .innerJoin(apps, eq(apps.id, jobs.appId))
    .where(
      and(
        eq(apps.organizationId, organizationId),
        sql`(${jobs.capabilities}->>'revision')::integer >= COALESCE(${apps.appliedCapabilityRevision}, -1)`,
      ),
    );

  return records.map((app) => ({
    app,
    grants: [
      ...Object.values(contract.capabilityGrants.parse(app.capabilities)),
      ...Object.values(
        app.appliedCapabilities
          ? contract.capabilitySnapshot.parse(app.appliedCapabilities).grants
          : {},
      ),
      ...agentSnapshots
        .filter((entry) => entry.appId === app.id)
        .flatMap((entry) =>
          Object.values(contract.capabilitySnapshot.parse(entry.capabilities).grants),
        ),
      ...pending
        .filter((entry) => entry.appId === app.id)
        .flatMap((entry) => Object.values(contract.capabilityState.parse(entry.result).grants)),
    ],
  }));
};

export const checkServiceConsumers = async (
  transaction: Transaction,
  app: Pick<typeof apps.$inferSelect, "id" | "organizationId">,
  entrypoints: string[],
) => {
  for (const consumer of await serviceConsumers(transaction, app.organizationId))
    if (
      consumer.grants.some(
        (grant) => grant.app === app.id && !entrypoints.includes(grant.entrypoint),
      )
    )
      throw conflict(
        "Disconnect active and pending app connections before removing their service entrypoint or app",
      );
};

const deployedEntrypoints = async (transaction: Transaction, app: typeof apps.$inferSelect) => {
  if (!app.activeDeploymentId || app.state === "deleting") return null;

  const [active] = await transaction
    .select({ metadata: artifacts.metadata })
    .from(deployments)
    .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
    .where(and(eq(deployments.appId, app.id), eq(deployments.id, app.activeDeploymentId)));

  if (!active) return null;

  const pending = await transaction
    .select({ metadata: artifacts.metadata })
    .from(deployments)
    .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
    .where(and(eq(deployments.appId, app.id), inArray(deployments.status, ["queued", "running"])));

  const metadata = contract.workerMetadata.parse(active.metadata);

  return {
    metadata,
    entrypoints: (metadata.entrypoints ?? []).filter((name) =>
      pending.every((record) =>
        contract.workerMetadata.parse(record.metadata).entrypoints?.includes(name),
      ),
    ),
  };
};

export const serviceEntrypoints = async (transaction: Transaction, app: typeof apps.$inferSelect) =>
  (await deployedEntrypoints(transaction, app))?.entrypoints ?? [];

/**
 * Lists the entrypoints the app publishes as an API. Every web app has a default handler for its
 * own HTTP routes, so the catalog lists the default entrypoint only when it has RPC methods or a
 * TSDoc comment that documents it as an API. Callers can still bind any entrypoint explicitly.
 */
export const catalogEntrypoints = async (
  transaction: Transaction,
  app: typeof apps.$inferSelect,
) => {
  const deployed = await deployedEntrypoints(transaction, app);

  if (!deployed) return [];
  const documented = deployed.metadata.service_documentation?.entrypoints;

  return deployed.entrypoints.filter(
    (name) =>
      name !== "default" ||
      !documented?.some(
        (entry) =>
          entry.name === name &&
          entry.methods.length === 0 &&
          !entry.summary &&
          !entry.remarks &&
          entry.examples.length === 0 &&
          !entry.deprecated,
      ),
  );
};

export const resolveAppService = async (
  transaction: Transaction,
  organizationId: string,
  grant: z.infer<typeof contract.capabilityGrant>,
) => {
  if (!grant.app) throw conflict("Target app is required");

  const [target] = await transaction
    .select()
    .from(apps)
    .where(
      and(eq(apps.id, grant.app), eq(apps.organizationId, organizationId), isNull(apps.removedAt)),
    )
    .for("update");

  if (!target || !(await serviceEntrypoints(transaction, target)).includes(grant.entrypoint))
    throw conflict("Deploy the target app's service entrypoint successfully before connecting it");

  return { ...grant, hostname: target.hostname, organizationId };
};

export const checkServiceCycle = async (
  transaction: Transaction,
  organizationId: string,
  source: string,
  target: string,
) => {
  const consumers = await serviceConsumers(transaction, organizationId);

  const graph = new Map(
    consumers.map(({ app, grants }) => [
      app.id,
      grants.flatMap((grant) => (grant.app ? [grant.app] : [])),
    ]),
  );

  const pending = [target];
  const visited = new Set<string>();

  while (pending.length) {
    const next = pending.pop();

    if (!next || visited.has(next)) continue;

    if (next === source) throw conflict("App connections cannot form a cycle");
    visited.add(next);
    pending.push(...(graph.get(next) ?? []));
  }
};
