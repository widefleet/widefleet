// Server builds: the app CI runs `widefleet deploy` on a commit from the app's
// Widefleet Git repository, as on a computer, under the authority of whoever
// started the build. It deploys with a token that is valid while the build runs.
import * as contract from "@platform/contracts";
import { ciBuildRequest, ciBuildResult } from "@platform/contracts/builds";
import { Result } from "better-result";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { readableApp } from "./apps.ts";
import { createBuildToken } from "./build-tokens.ts";
import { sourceTarget } from "./app-source.ts";
import type { Database } from "./database.ts";
import { deploymentActor } from "./deployment-execution.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import type { SignIn } from "./sso-policy.ts";
import { appBuilds, apps, artifacts, deployments } from "./schema.ts";
import { sourceOperation, type SourceBackend } from "./source-backend.ts";
import { readOnly, transact } from "./transactions.ts";

/** The app CI, which keeps each build's outcome until it is released. */
export interface AppCi {
  build: (request: z.infer<typeof ciBuildRequest>) => Promise<z.infer<typeof ciBuildResult>>;
  /** The outcome of a build that already ran. */
  result: (id: string) => Promise<z.infer<typeof ciBuildResult> | null>;
  release: (id: string) => Promise<void>;
}

/** The CI Worker's `AppCi` entrypoint, whose answers are checked like any other input. */
export const bindingAppCi = (binding: AppCi): AppCi => ({
  build: async (request) => ciBuildResult.parse(await binding.build(ciBuildRequest.parse(request))),
  result: async (id) => ciBuildResult.nullable().parse(await binding.result(id)),
  release: (id) => binding.release(id),
});

const presentBuild = (record: typeof appBuilds.$inferSelect) =>
  contract.appBuild.parse({
    id: record.id,
    appId: record.appId,
    source: { commit: record.commit, branch: record.branch, directory: record.directory },
    status: record.status,
    deploymentId: record.deploymentId,
    message: record.message,
    createdAt: record.createdAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
  });

const unavailable = () =>
  new InvalidOperation({
    code: "CONFLICT",
    message: "This installation does not build apps on the server; deploy with the Widefleet CLI",
  });

export const createBuildService = (
  database: Database,
  source?: SourceBackend,
  run?: (id: string) => Promise<void>,
) => ({
  available: Boolean(source && run),
  start: (
    principal: Principal,
    signIn: SignIn,
    appId: string,
    input: z.infer<typeof contract.appBuildInput>,
  ) =>
    Result.gen(async function* () {
      if (!source || !run) return yield* unavailable();

      const build = yield* Result.await(
        transact(database, async (transaction) => {
          const target = await sourceTarget(transaction, principal, appId);

          if (target.isErr()) return target;
          const { app, id: repository, branch } = target.value;

          if (app.parentId && !app.sourceBranch)
            return Result.err(
              new InvalidOperation({
                code: "CONFLICT",
                message:
                  "This preview was created without a Git branch. Create a preview from a work branch to build it",
              }),
            );

          // An app without saved source has no repository yet.
          const commit =
            (await sourceOperation(() => source.repository(repository))) &&
            (await sourceOperation(() => source.head(repository, branch)));

          if (!commit)
            return Result.err(
              new InvalidOperation({
                code: "CONFLICT",
                message: `The branch ${branch} has no commits. Save source with widefleet deploy first`,
              }),
            );

          // A build uses the project directory of the active deployment unless told otherwise.
          const [active] = app.activeDeploymentId
            ? await transaction
                .select({ metadata: artifacts.metadata })
                .from(deployments)
                .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
                .where(eq(deployments.id, app.activeDeploymentId))
            : [];

          const directory =
            input.directory ??
            (active
              ? contract.workerMetadata.parse(active.metadata).source?.directory
              : undefined) ??
            ".";

          const [record] = await transaction
            .insert(appBuilds)
            .values({
              id: crypto.randomUUID(),
              appId,
              actor: deploymentActor.parse({
                id: principal.id,
                admin: principal.admin,
                application: principal.application,
              }),
              commit,
              branch,
              directory,
              identityOrganizationId: signIn.identityOrganizationId,
              recovery: signIn.recovery,
            })
            .returning();

          if (!record) throw new Error("The build was not recorded");

          // The build is recorded only with its workflow; one that starts before
          // the commit waits for the record.
          await run(record.id);

          return Result.ok(record);
        }),
      );

      return Result.ok(presentBuild(build));
    }),
  list: (principal: Principal, appId: string) =>
    readOnly(database, (executor) =>
      Result.gen(async function* () {
        yield* Result.await(readableApp(executor, principal, appId));

        const records = await executor
          .select()
          .from(appBuilds)
          .where(eq(appBuilds.appId, appId))
          .orderBy(desc(appBuilds.createdAt))
          .limit(50);

        return Result.ok(records.map(presentBuild));
      }),
    ),
  read: (principal: Principal, appId: string, buildId: string) =>
    readOnly(database, (executor) =>
      Result.gen(async function* () {
        yield* Result.await(readableApp(executor, principal, appId));

        const [record] = await executor
          .select()
          .from(appBuilds)
          .where(and(eq(appBuilds.id, buildId), eq(appBuilds.appId, appId)));

        if (!record)
          return yield* new InvalidOperation({ code: "NOT_FOUND", message: "Build not found" });

        return Result.ok(
          contract.appBuildDetails.parse({ ...presentBuild(record), log: record.log }),
        );
      }),
    ),
});

export type BuildService = ReturnType<typeof createBuildService>;

/**
 * Runs a recorded build to its end. A repeated run builds again; the build ID
 * is the deployment's request ID, so the build publishes at most once.
 */
export const executeBuild = async (
  id: string,
  services: {
    /** Each database phase holds a connection only while it runs, not during the build. */
    withDatabase: <T>(operation: (database: Database) => Promise<T>) => Promise<T>;
    source: SourceBackend;
    ci: AppCi;
    platformUrl: string;
  },
) => {
  const { withDatabase, source, ci } = services;

  const token = createBuildToken();

  const loaded = await withDatabase(async (database) => {
    const [recorded] = await database
      .select({ status: appBuilds.status })
      .from(appBuilds)
      .where(eq(appBuilds.id, id));

    // The request that started the build may not have committed yet; the run is retried.
    if (!recorded) throw new Error("The build is not recorded");

    const [record] = await database
      .update(appBuilds)
      .set({ status: "running", tokenHash: token.hash, tokenExpiresAt: token.expiresAt })
      .where(and(eq(appBuilds.id, id), inArray(appBuilds.status, ["queued", "running"])))
      .returning();

    if (!record) return undefined;

    const [app] = await database
      .select({ parentId: apps.parentId })
      .from(apps)
      .where(eq(apps.id, record.appId));

    return { build: record, parentId: app?.parentId ?? null };
  });

  // The build has finished. A previous run may have stopped before it released the CI.
  if (!loaded) {
    await ci.release(id);

    return;
  }

  const { build, parentId } = loaded;

  // PostgreSQL text cannot hold NUL, which command output may contain.
  const text = (value: string | null | undefined) => value?.replaceAll("\u0000", "");

  const finish = (values: Partial<typeof appBuilds.$inferInsert>) =>
    withDatabase((database) =>
      database
        .update(appBuilds)
        .set({
          ...values,
          message: text(values.message),
          log: text(values.log),
          tokenHash: null,
          tokenExpiresAt: null,
          finishedAt: new Date(),
        })
        .where(and(eq(appBuilds.id, id), inArray(appBuilds.status, ["queued", "running"]))),
    );

  const published = () =>
    withDatabase(async (database) => {
      const [deployment] = await database
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(eq(deployments.appId, build.appId), eq(deployments.requestId, id)));

      return deployment;
    });

  // The outcome of a build that published follows its recorded result.
  const conclude = async (
    result: z.infer<typeof ciBuildResult> | null,
    deployment: { id: string } | undefined,
  ) => {
    if (result?.status === "failed")
      await finish({
        status: "failed",
        message: result.message,
        log: result.log,
        deploymentId: deployment?.id ?? null,
      });
    else if (deployment)
      await finish({ status: "succeeded", deploymentId: deployment.id, log: result?.log ?? "" });
    else
      await finish({
        status: "failed",
        message: "widefleet deploy did not publish the build",
        log: result?.log ?? "",
      });

    await ci.release(id);
  };

  // A run that stopped after publishing does not build again.
  const previous = await published();

  if (previous) return conclude(await ci.result(id), previous);

  const actor = deploymentActor.parse(build.actor);

  const repository = await sourceOperation(() => source.repository(parentId ?? build.appId));

  if (!repository) {
    await finish({ status: "failed", message: "The app has no Git repository" });
    await ci.release(id);

    return;
  }

  const result = await ci.build({
    id,
    appId: build.appId,
    platform: {
      url: services.platformUrl,
      organizationId: actor.application.organizationId,
      token: token.value,
    },
    repository: { url: repository.url },
    source: contract.sourceRevision.parse({
      commit: build.commit,
      branch: build.branch,
      directory: build.directory,
    }),
  });

  return conclude(result, await published());
};

/** Records a build whose runs all failed. */
export const failBuild = (database: Database, id: string, message: string) =>
  database
    .update(appBuilds)
    .set({
      status: "failed",
      message,
      tokenHash: null,
      tokenExpiresAt: null,
      finishedAt: new Date(),
    })
    .where(and(eq(appBuilds.id, id), inArray(appBuilds.status, ["queued", "running"])));
