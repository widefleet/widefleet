import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { managedApp, readableApp, enqueueDeployment, presentDeployment } from "./apps.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import type { Principal } from "./identity.ts";
import { apps, artifacts, deployments } from "./schema.ts";
import { encryptSecret } from "./secret-encryption.ts";
import { InvalidOperation } from "./errors.ts";
import { requireAgentExecution } from "./organization-runtime.ts";
import { readOnly, transact, type Transaction } from "./transactions.ts";

export const storedAppSecrets = z.record(contract.appSecretName, z.string().min(1));

const status = async (transaction: DatabaseExecutor, app: typeof apps.$inferSelect) => {
  const [deployment] = app.secretDeploymentId
    ? await transaction.select().from(deployments).where(eq(deployments.id, app.secretDeploymentId))
    : [];

  // The latest accepted code, which secret changes redeploy.
  const [latest] = await transaction
    .select({ metadata: artifacts.metadata })
    .from(deployments)
    .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
    .where(eq(deployments.appId, app.id))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(1);

  return contract.appSecretStatus.parse({
    names: Object.keys(storedAppSecrets.parse(app.secrets)).sort(),
    required: latest ? (contract.workerMetadata.parse(latest.metadata).required_secrets ?? []) : [],
    revision: app.secretRevision,
    appliedRevision: app.appliedSecretRevision,
    deployment: deployment ? presentDeployment(deployment) : null,
  });
};

/**
 * Saves encrypted secret changes, `null` deleting one, on an app whose row
 * the transaction locks. Secret edits and a template's first deployment
 * save them alike.
 */
export const saveAppSecrets = async (
  transaction: Transaction,
  app: typeof apps.$inferSelect,
  changes: Readonly<Record<string, string | null>>,
  { hosted, variables }: { hosted: boolean; variables: number },
) => {
  if (!hosted) await requireAgentExecution(transaction, app.organizationId, "App secrets");

  if (app.state === "deleting")
    throw new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" });
  const secrets = new Map(Object.entries(storedAppSecrets.parse(app.secrets)));

  for (const [name, value] of Object.entries(changes))
    if (value === null) secrets.delete(name);
    else secrets.set(name, value);

  if (secrets.size + variables > contract.appEnvironmentMaxBindings)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "App variables and secrets exceed the binding limit",
    });

  const [updated] = await transaction
    .update(apps)
    .set({ secrets: Object.fromEntries(secrets), secretRevision: app.secretRevision + 1 })
    .where(eq(apps.id, app.id))
    .returning();

  if (!updated) throw new Error("App secret update returned no row");

  return updated;
};

export const createAppSecrets = (
  database: Database,
  encryptionKey: string,
  execution?: HostedExecution,
) => ({
  /** Encrypts validated values for saveAppSecrets. */
  encrypt: async (values: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(values).map(
          async ([name, value]) => [name, await encryptSecret(encryptionKey, value)] as const,
        ),
      ),
    ),
  read: (principal: Principal, appId: string) =>
    readOnly(database, async (transaction) => {
      const access = await readableApp(transaction, principal, appId);

      if (access.isErr()) return access;

      return Result.ok(await status(transaction, access.value));
    }),
  set: async (principal: Principal, appId: string, name: string, value: string | null) => {
    contract.appSecretName.parse(name);

    if (value !== null) contract.appSecretValue.parse(value);
    const requestId = crypto.randomUUID();

    const prepared = await transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;
      const app = access.value;

      // A secret edit must not roll a pending code deployment back to the last
      // serving artifact. Follow the latest accepted code selection.
      const [active] = await transaction
        .select({ artifactId: deployments.artifactId })
        .from(deployments)
        .where(eq(deployments.appId, appId))
        .orderBy(desc(deployments.createdAt), desc(deployments.id))
        .limit(1);

      const [artifact] = active
        ? await transaction.select().from(artifacts).where(eq(artifacts.id, active.artifactId))
        : [];

      const variables = artifact
        ? contract.workerMetadata
            .parse(artifact.metadata)
            .bindings.filter((binding) => binding.type === "plain_text").length
        : 0;

      const updated = await saveAppSecrets(
        transaction,
        app,
        { [name]: value === null ? null : await encryptSecret(encryptionKey, value) },
        { hosted: Boolean(execution), variables },
      );

      const deployment = active
        ? (
            await enqueueDeployment(transaction, updated, active.artifactId, requestId, {
              hosted: Boolean(execution),
              secretChange: true,
            })
          ).unwrap()
        : null;

      if (deployment)
        await transaction
          .update(apps)
          .set({ secretDeploymentId: deployment.id })
          .where(eq(apps.id, appId));

      return Result.ok({ ...(await status(transaction, updated)), deployment });
    });

    if (prepared.isErr() || !execution || !prepared.value.deployment) return prepared;

    const deployed = await execution.deploy(
      prepared.value.deployment,
      requestId,
      false,
      undefined,
      {
        refreshSecrets: true,
      },
    );

    if (deployed.isErr()) return Result.err(deployed.error);

    return Result.ok({ ...prepared.value, deployment: deployed.value });
  },
});
