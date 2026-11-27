// Server builds: the app CI builds a commit from the app's Widefleet Git
// repository with `widefleet build --output`, and the output is published
// through the same upload path as `widefleet deploy`, under the authority of
// whoever started the build.
import * as contract from "@platform/contracts";
import { ciBuildOutput, ciBuildRequest, ciBuildResult } from "@platform/contracts/builds";
import { Result } from "better-result";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { readableApp } from "./apps.ts";
import { sourceTarget } from "./app-source.ts";
import type { Database } from "./database.ts";
import { deploymentActor } from "./deployment-execution.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { appBuilds, apps, artifacts, deployments } from "./schema.ts";
import { sourceOperation, type SourceBackend } from "./source-backend.ts";
import { readOnly, transact } from "./transactions.ts";
import type { createUploadService } from "./uploads.ts";
import type { WorkerModule } from "./worker-modules.ts";

/** The app CI, which keeps each build's output until it is released. */
export interface AppCi {
  build: (request: z.infer<typeof ciBuildRequest>) => Promise<z.infer<typeof ciBuildResult>>;
  file: (id: string, path: string) => Promise<Uint8Array>;
  release: (id: string) => Promise<void>;
}

/** The CI Worker's `AppCi` entrypoint, whose answers are checked like any other input. */
export const bindingAppCi = (binding: AppCi): AppCi => ({
  build: async (request) => ciBuildResult.parse(await binding.build(ciBuildRequest.parse(request))),
  file: (id, path) => binding.file(id, path),
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
  start: (principal: Principal, appId: string, input: z.infer<typeof contract.appBuildInput>) =>
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

          const commit =
            input.commit ?? (await sourceOperation(() => source.head(repository, branch)));

          if (!commit)
            return Result.err(
              new InvalidOperation({
                code: "CONFLICT",
                message: `The branch ${branch} has no commits. Save source with widefleet deploy first`,
              }),
            );

          if (input.commit && !(await sourceOperation(() => source.hasCommit(repository, commit))))
            return Result.err(
              new InvalidOperation({
                code: "BAD_REQUEST",
                message: "The commit is not stored in this app's repository",
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
            })
            .returning();

          if (!record) throw new Error("The build was not recorded");

          return Result.ok(record);
        }),
      );

      try {
        await run(build.id);
      } catch (cause) {
        await database
          .update(appBuilds)
          .set({
            status: "failed",
            message: "The build could not be started",
            finishedAt: new Date(),
          })
          .where(eq(appBuilds.id, build.id));
        throw cause;
      }

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
 * Runs a recorded build to its end: build, upload and publish. A repeated run
 * continues where the previous one stopped; the build ID is the deployment's
 * request ID, so it publishes at most once.
 */
export const executeBuild = async (
  id: string,
  services: {
    /** Each database phase holds a connection only while it runs, not during the build. */
    withDatabase: <T>(operation: (database: Database) => Promise<T>) => Promise<T>;
    source: SourceBackend;
    ci: AppCi;
    uploads: (
      database: Database,
    ) => Pick<ReturnType<typeof createUploadService>, "start" | "putAsset" | "publish">;
  },
) => {
  const { withDatabase, source, ci } = services;

  const loaded = await withDatabase(async (database) => {
    const [record] = await database
      .select({ build: appBuilds, parentId: apps.parentId })
      .from(appBuilds)
      .innerJoin(apps, eq(apps.id, appBuilds.appId))
      .where(eq(appBuilds.id, id));

    if (record?.build.status === "queued")
      await database.update(appBuilds).set({ status: "running" }).where(eq(appBuilds.id, id));

    return record;
  });

  // The app was removed with its builds.
  if (!loaded) return;
  const { build, parentId } = loaded;

  if (build.status === "succeeded" || build.status === "failed") return;

  const finish = (values: Partial<typeof appBuilds.$inferInsert>) =>
    withDatabase((database) =>
      database
        .update(appBuilds)
        .set({ ...values, finishedAt: new Date() })
        .where(and(eq(appBuilds.id, id), inArray(appBuilds.status, ["queued", "running"]))),
    );

  const actor = deploymentActor.parse(build.actor);

  const revision = contract.sourceRevision.parse({
    commit: build.commit,
    branch: build.branch,
    directory: build.directory,
  });

  const result = await ci.build({
    id,
    repository: await sourceOperation(() => source.credential(parentId ?? build.appId, "read")),
    commit: revision.commit,
    directory: revision.directory,
  });

  if (result.status === "failed") {
    await finish({ status: "failed", message: result.message, log: result.log });
    await ci.release(id);

    return;
  }

  const output = ciBuildOutput.parse(JSON.parse(result.output));

  const published = await withDatabase(async (database) => {
    // A run that stopped after publishing finds its deployment.
    const [existing] = await database
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.appId, build.appId), eq(deployments.requestId, id)));

    if (existing) return Result.ok(existing.id);

    const uploads = services.uploads(database);

    return Result.gen(async function* () {
      const session = yield* Result.await(
        uploads.start(actor, build.appId, output.assets.manifest),
      );

      for (const hash of session.missing) {
        const path = output.assets.files[hash];

        if (!path)
          return yield* new InvalidOperation({
            code: "BAD_REQUEST",
            message: "The build output lacks an asset of its manifest",
          });

        yield* Result.await(
          uploads.putAsset(actor, build.appId, session.id, hash, await ci.file(id, path)),
        );
      }

      const modules: WorkerModule[] = [];

      for (const module of output.modules)
        modules.push({
          name: module.name,
          type: module.type,
          bytes: await ci.file(id, module.path),
        });

      const metadata = contract.workerMetadata.safeParse({
        ...output.metadata,
        assets: {
          ...z.record(z.string(), z.json()).parse(output.metadata["assets"] ?? {}),
          upload_session: session.id,
        },
        source: revision,
      });

      if (!metadata.success)
        return yield* new InvalidOperation({
          code: "BAD_REQUEST",
          message: `The build is not deployable: ${z.prettifyError(metadata.error)}`,
        });

      const deployment = yield* Result.await(
        uploads.publish(actor, build.appId, metadata.data, output.documentation, modules, id),
      );

      return Result.ok(deployment.id);
    });
  });

  if (published.isErr()) {
    // Unavailable storage or databases fail the attempt, which the caller retries.
    if (!(published.error instanceof InvalidOperation)) throw published.error;

    await finish({ status: "failed", message: published.error.message, log: result.log });
  } else await finish({ status: "succeeded", deploymentId: published.value, log: result.log });

  await ci.release(id);
};

/** Records a build whose runs all failed. */
export const failBuild = (database: Database, id: string, message: string) =>
  database
    .update(appBuilds)
    .set({ status: "failed", message, finishedAt: new Date() })
    .where(and(eq(appBuilds.id, id), inArray(appBuilds.status, ["queued", "running"])));
