// Server builds: the app CI runs `widefleet deploy` on a commit from the app's
// Widefleet Git repository, as on a computer, under the authority of whoever
// started the build. It deploys with a token that is valid while the build runs.
import * as contract from "@platform/contracts";
import { ciBuildRequest, ciBuildResult, ciBuildTimeLimit } from "@platform/contracts/builds";
import { Result } from "better-result";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { readableApp } from "./apps.ts";
import { createBuildToken } from "./build-tokens.ts";
import { sourceTarget } from "./app-source.ts";
import type { Database } from "./database.ts";
import { deploymentActor } from "./deployment-execution.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import type { SecretEncryption } from "./secret-encryption.ts";
import type { BuildPolicy } from "./runtime-extension.ts";
import type { SignIn } from "./sso-policy.ts";
import { appBuilds, apps, artifacts, deployments } from "./schema.ts";
import { sourceOperation, type SourceBackend } from "./source-backend.ts";
import { readOnly, transact } from "./transactions.ts";

/** The longest a build runs, in seconds; a build policy admits at most this. */
export { ciBuildTimeLimit } from "@platform/contracts/builds";

/**
 * The app CI. It runs each build at most once and keeps its outcome; releasing
 * a build stops its container and drops its log.
 */
export interface AppCi {
  build: (request: z.infer<typeof ciBuildRequest>) => Promise<z.infer<typeof ciBuildResult>>;
  /** The outcome of a build that ran, waiting for one that is running. */
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

/**
 * Finishes a build that is still queued or running, which ends its tokens. A build
 * whose outcome the CI reported is settled at once with its container time.
 * Otherwise its container may still run until its deadline, so the policy keeps
 * the build's whole reservation and slot until then.
 */
const endBuild = (
  database: Database,
  policy: BuildPolicy | undefined,
  id: string,
  values: Partial<typeof appBuilds.$inferInsert>,
  seconds?: number | null,
) =>
  database.transaction(async (transaction) => {
    const [ended] = await transaction
      .update(appBuilds)
      .set({
        ...values,
        finishedAt: new Date(),
      })
      .where(and(eq(appBuilds.id, id), inArray(appBuilds.status, ["queued", "running"])))
      .returning();

    if (ended && seconds !== undefined) await policy?.settle(transaction, { id, seconds });

    return ended;
  });

const unavailable = () =>
  new InvalidOperation({
    code: "CONFLICT",
    message: "This installation does not build apps on the server; deploy with the Widefleet CLI",
  });

export const createBuildService = (
  database: Database,
  source?: SourceBackend,
  workflows?: { start: (id: string) => Promise<void>; ended: (id: string) => Promise<boolean> },
  policy?: BuildPolicy,
) => {
  // A build whose workflow ended without finishing it has failed, and its token
  // ends with it. A build that finished meanwhile keeps its outcome.
  const reconcile = async (record: typeof appBuilds.$inferSelect) => {
    if (!workflows || (record.status !== "queued" && record.status !== "running")) return record;

    if (!(await workflows.ended(record.id).catch(() => false))) return record;

    const failed = await endBuild(database, undefined, record.id, {
      status: "failed",
      message: "The build stopped before it finished",
    });

    if (failed) return failed;

    const [current] = await database.select().from(appBuilds).where(eq(appBuilds.id, record.id));

    return current ?? record;
  };

  return {
    available: Boolean(source && workflows),
    start: (
      principal: Principal,
      /** How the starter signed in, and whether their credential may read. */
      signIn: SignIn & { reads: boolean },
      appId: string,
      input: z.infer<typeof contract.appBuildInput>,
    ) =>
      Result.gen(async function* () {
        if (!source || !workflows) return yield* unavailable();

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

            const id = crypto.randomUUID();

            // The installation may limit how much container time builds use.
            const admitted = policy
              ? await policy.admit(transaction, { id, organizationId: app.organizationId, appId })
              : ciBuildTimeLimit;

            if (admitted instanceof InvalidOperation) return Result.err(admitted);

            const [record] = await transaction
              .insert(appBuilds)
              .values({
                id,
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
                reads: signIn.reads,
                // Like a reservation of the policy, the deadline counts from the
                // start of this transaction.
                deadline: sql`now() + make_interval(secs => ${Math.min(Math.floor(admitted), ciBuildTimeLimit)})`,
              })
              .returning();

            if (!record) throw new Error("The build was not recorded");

            // The build is recorded only with its workflow; one that starts before
            // the commit waits for the record.
            await workflows.start(record.id);

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

          return Result.ok((await Promise.all(records.map(reconcile))).map(presentBuild));
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

          const current = await reconcile(record);

          return Result.ok(
            contract.appBuildDetails.parse({ ...presentBuild(current), log: current.log }),
          );
        }),
      ),
  };
};

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
    encryption: SecretEncryption;
    /** Settles the build's container time; installations without one do not limit it. */
    policy: BuildPolicy | undefined;
  },
) => {
  const { withDatabase, source, ci, policy } = services;

  const loaded = await withDatabase(async (database) => {
    const [recorded] = await database
      .select({ status: appBuilds.status })
      .from(appBuilds)
      .where(eq(appBuilds.id, id));

    // The request that started the build may not have committed yet; the run is retried.
    if (!recorded) throw new Error("The build is not recorded");

    const [record] = await database
      .update(appBuilds)
      .set({ status: "running" })
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

  // Without the CI's seconds, the build keeps its reservation until its deadline.
  const finish = (values: Partial<typeof appBuilds.$inferInsert>, seconds?: number) =>
    withDatabase((database) =>
      endBuild(
        database,
        policy,
        id,
        { ...values, message: text(values.message), log: text(values.log) },
        seconds,
      ),
    );

  const published = () =>
    withDatabase(async (database) => {
      const [deployment] = await database
        .select({ id: deployments.id, metadata: artifacts.metadata })
        .from(deployments)
        .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
        .where(and(eq(deployments.appId, build.appId), eq(deployments.requestId, id)));

      return deployment
        ? {
            id: deployment.id,
            commit: contract.workerMetadata.parse(deployment.metadata).source?.commit,
          }
        : undefined;
    });

  // The outcome of a build that published follows its recorded result.
  const conclude = async (
    result: z.infer<typeof ciBuildResult> | null,
    deployment: Awaited<ReturnType<typeof published>>,
  ) => {
    // The CI loses the log and the container time of a run if it restarts before
    // recording them; the build then keeps all the time it was admitted with.
    const log = result?.log ?? "The CI restarted during the build; its log was not kept.\n";
    const seconds = result?.seconds;
    const deploymentId = deployment?.id ?? null;

    if (result?.status === "failed")
      await finish({ status: "failed", message: result.message, log, deploymentId }, seconds);
    else if (!deployment)
      await finish(
        { status: "failed", message: "widefleet deploy did not publish the build", log },
        seconds,
      );
    // Code in the build can name another commit than the one it was asked to build.
    else if (deployment.commit !== build.commit)
      await finish(
        {
          status: "failed",
          message: `The build published ${deployment.commit ?? "no commit"} instead of ${build.commit}`,
          log,
          deploymentId,
        },
        seconds,
      );
    else await finish({ status: "succeeded", deploymentId, log }, seconds);

    await ci.release(id);
  };

  // A run that stopped after publishing does not build again; it waits for
  // the CI if the build is still finishing there, whatever changed since.
  const previous = await published();

  if (previous) return conclude(await ci.result(id), previous);

  const actor = deploymentActor.parse(build.actor);

  const repository = await sourceOperation(() => source.repository(parentId ?? build.appId));

  if (!repository) {
    // An earlier run may have used container time before the repository was removed.
    await finish({ status: "failed", message: "The app has no Git repository" });
    await ci.release(id);

    return;
  }

  const request = {
    id,
    appId: build.appId,
    platform: {
      url: services.platformUrl,
      organizationId: actor.application.organizationId,
      token: await createBuildToken(services.encryption, id),
    },
    repository: { url: repository.url },
    source: contract.sourceRevision.parse({
      commit: build.commit,
      branch: build.branch,
      directory: build.directory,
    }),
    deadline: build.deadline.getTime(),
  };

  const result = await ci.build(request);

  return conclude(result, await published());
};

/**
 * Records a build whose runs all failed. A workflow can fail before the request
 * that started it has committed the build, so a missing build is retried.
 */
export const failBuild = async (database: Database, id: string, message: string) => {
  const [recorded] = await database
    .select({ id: appBuilds.id })
    .from(appBuilds)
    .where(eq(appBuilds.id, id));

  if (!recorded) throw new Error("The build is not recorded");

  // Its container may still run, so its time is not settled.
  await endBuild(database, undefined, id, { status: "failed", message });
};
