import * as contract from "@platform/contracts";
import { eq } from "drizzle-orm";
import { InvalidOperation } from "./errors.ts";
import { apps, connectors, deployments, fleets, jobs } from "./schema.ts";
import { connectorReference } from "./connectors.ts";
import { ensureFleetRuntime, runtimeReference } from "./runtime-releases.ts";
import type { ArtifactStorage } from "./storage.ts";
import type { Transaction } from "./transactions.ts";

export const prepareJob = async (
  transaction: Transaction,
  storage: ArtifactStorage,
  job: typeof jobs.$inferSelect,
  fleet: typeof fleets.$inferSelect,
  artifactId: string | null,
  accessRules: boolean,
) => {
  const [app] = job.appId
    ? await transaction.select().from(apps).where(eq(apps.id, job.appId)).for("update")
    : [];

  if (app && app.accessRevision > 0 && !accessRules && job.kind !== "delete")
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "Upgrade the agent to support app access rules before claiming this job",
    });

  let deploymentId = job.deploymentId;

  if (job.kind === "configure") {
    deploymentId = app?.activeDeploymentId ?? null;

    const [active] = deploymentId
      ? await transaction
          .select({ artifactId: deployments.artifactId })
          .from(deployments)
          .where(eq(deployments.id, deploymentId))
      : [];

    artifactId = active?.artifactId ?? null;
  }

  const access = app
    ? contract.appAccessSnapshot.parse({
        revision: app.accessRevision,
        groups: app.accessGroups,
      })
    : null;

  const network = app
    ? contract.networkSnapshot.parse({
        revision: app.networkRevision,
        policy: app.networkPolicy,
      })
    : null;

  const capabilities = app
    ? contract.capabilitySnapshot.parse({
        revision: app.capabilityRevision,
        grants: app.capabilities,
      })
    : null;

  const installed = await transaction
    .select()
    .from(connectors)
    .where(eq(connectors.fleetId, fleet.id));

  let selectedConnectors = installed.flatMap((entry) =>
    entry.appliedPackage ? [connectorReference.parse(entry.appliedPackage)] : [],
  );

  if (job.kind === "connector") {
    const next = connectorReference.parse(job.connector);
    selectedConnectors = [...selectedConnectors.filter((entry) => entry.name !== next.name), next];
  }

  selectedConnectors.sort((left, right) => left.name.localeCompare(right.name));

  const selectedRuntime =
    job.kind === "runtime"
      ? runtimeReference.parse(job.runtime)
      : fleet.appliedRuntime
        ? runtimeReference.parse(fleet.appliedRuntime)
        : await ensureFleetRuntime(transaction, storage, fleet.id);

  return {
    deploymentId,
    artifactId,
    access,
    network,
    capabilities,
    runtime: selectedRuntime,
    connectors: selectedConnectors,
  };
};
