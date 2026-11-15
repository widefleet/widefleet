import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Database } from "./database.ts";
import type { Principal } from "./identity.ts";
import { sourceOperation, type SourceBackend } from "./source-backend.ts";
import { appVisibility, managedApp } from "./apps.ts";
import { apps, artifacts, deployments } from "./schema.ts";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import { transact, type Transaction } from "./transactions.ts";

const sourceTarget = async (
  transaction: Transaction,
  principal: Principal,
  appId: string,
  mutating = true,
) => {
  const [candidate] = await transaction
    .select()
    .from(apps)
    .where(and(eq(apps.id, appId), appVisibility(transaction, principal)));

  if (!candidate)
    return Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App not found" }));

  let primaryBranch: string | undefined;

  // Use the same parent-before-child lock order as app removal and access changes.
  if (mutating && candidate.parentId) {
    const parent = await managedApp(transaction, principal, candidate.parentId);

    if (parent.isErr()) return parent;

    primaryBranch = parent.value.sourceBranch ?? "main";

    if (parent.value.state === "deleting")
      return Result.err(
        new InvalidOperation({ code: "CONFLICT", message: "The parent app is being deleted" }),
      );
  }

  const access = mutating ? await managedApp(transaction, principal, appId) : Result.ok(candidate);

  if (access.isErr()) return access;
  const app = access.value;

  if (mutating && app.state === "deleting")
    return Result.err(new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" }));

  return Result.ok({
    app,
    primaryBranch,
    id: app.parentId ?? app.id,
    branch: app.sourceBranch ?? "main",
  });
};

export const createAppSource = (database: Database, backend?: SourceBackend) => {
  const setup = (
    principal: Principal,
    appId: string,
    input: z.infer<typeof contract.sourceSetup>,
  ) =>
    transact(database, async (transaction) => {
      const target = await sourceTarget(transaction, principal, appId);

      if (target.isErr()) return target;

      if (!backend)
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "This installation does not provide Git repositories",
          }),
        );
      const { app, id, primaryBranch } = target.value;

      if (
        app.parentId &&
        (!app.sourceBranch || (input.branch !== undefined && input.branch !== app.sourceBranch))
      )
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: app.sourceBranch
              ? `This preview is linked to branch ${app.sourceBranch}. Deploy another branch as its own preview`
              : "This preview was created without a Git branch. Create a preview from another work branch to save source",
          }),
        );

      const branch = input.branch ?? target.value.branch;

      if (branch === primaryBranch)
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "A preview must use a different source branch from the main app",
          }),
        );

      const repository = await sourceOperation(
        async () => (await backend.repository(id)) ?? backend.create(id),
      );

      await transaction.update(apps).set({ sourceBranch: branch }).where(eq(apps.id, app.id));
      const commit = await sourceOperation(() => backend.head(id, branch));

      return Result.ok({
        organizationId: principal.application.organizationId,
        repository: contract.sourceRepository.parse({ ...repository, branch, commit }),
        primaryBranch,
      });
    });

  const source = {
    deploymentTarget: async (
      principal: Principal,
      input: z.infer<typeof contract.sourceDeployTargetInput>,
    ) => {
      const [app] = await database
        .select({ branch: apps.sourceBranch, parentId: apps.parentId })
        .from(apps)
        .where(
          and(
            "appId" in input ? eq(apps.id, input.appId) : eq(apps.slug, input.slug),
            appVisibility(database, principal),
          ),
        );

      if (!app && "appId" in input)
        return Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App not found" }));

      // A first deployment by name uses main. Inspect only local metadata: this
      // check must not create an app/repository or contact the Git backend.
      return Result.ok({
        supported: Boolean(backend),
        branch: app?.branch ?? "main",
        preview: app?.parentId != null,
      });
    },
    read: async (principal: Principal, appId: string) => {
      const snapshot = await transact(database, async (transaction) => {
        const target = await sourceTarget(transaction, principal, appId, false);

        if (target.isErr()) return target;
        const { app } = target.value;

        const [active] = app.activeDeploymentId
          ? await transaction
              .select({ metadata: artifacts.metadata })
              .from(deployments)
              .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
              .where(eq(deployments.id, app.activeDeploymentId))
          : [];

        const deployed = active
          ? (contract.workerMetadata.parse(active.metadata).source ?? null)
          : null;

        return Result.ok({ ...target.value, deployed });
      });

      if (snapshot.isErr()) return Result.err(snapshot.error);
      const { app, id, branch, deployed } = snapshot.value;

      if (!backend || (app.parentId && !app.sourceBranch))
        return Result.ok(
          contract.appSource.parse({
            supported: Boolean(backend),
            available: false,
            repository: null,
            deployed,
          }),
        );

      // Git latency must not keep a database connection occupied.
      try {
        const repository = await sourceOperation(() => backend.repository(id));
        const commit = repository ? await sourceOperation(() => backend.head(id, branch)) : null;

        return Result.ok(
          contract.appSource.parse({
            supported: true,
            available: commit !== null,
            repository: repository ? { ...repository, branch, commit } : null,
            deployed,
          }),
        );
      } catch (error) {
        if (!(error instanceof StorageUnavailable)) throw error;

        return Result.ok(
          contract.appSource.parse({
            supported: true,
            available: false,
            repository: null,
            deployed,
            error: error.message,
          }),
        );
      }
    },
    setup: async (
      principal: Principal,
      appId: string,
      input: z.infer<typeof contract.sourceSetup>,
    ) => {
      const prepared = await setup(principal, appId, input);

      if (prepared.isErr()) return Result.err(prepared.error);

      return Result.ok(prepared.value.repository);
    },
    credential: (principal: Principal, appId: string, scope: "read" | "write") =>
      transact(database, async (transaction) => {
        const target = await sourceTarget(transaction, principal, appId);

        if (target.isErr()) return target;

        if (!backend)
          return Result.err(
            new InvalidOperation({
              code: "CONFLICT",
              message: "This installation does not provide Git repositories",
            }),
          );
        const credential = await sourceOperation(() => backend.credential(target.value.id, scope));

        return Result.ok(contract.sourceCredential.parse(credential));
      }),
  };

  return {
    ...source,
    prepare: async (
      principal: Principal,
      appId: string,
      input: z.infer<typeof contract.sourceSetup>,
    ) => {
      if (!backend) {
        const status = await source.read(principal, appId);

        if (status.isErr()) return Result.err(status.error);

        return Result.ok(
          contract.sourcePreparation.parse({
            organizationId: principal.application.organizationId,
            repository: null,
          }),
        );
      }

      return setup(principal, appId, input);
    },
  };
};
