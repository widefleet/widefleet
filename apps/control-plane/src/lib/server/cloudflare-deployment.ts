import { resolveCloudflareCapabilities } from "./cloudflare-capabilities.ts";
import { checkCapabilityNames } from "./connector-changes.ts";
import { CloudflareSubscriptionPending } from "./cloudflare-subscription-updates.ts";
import { createCloudflareEvents } from "./cloudflare-events.ts";
import { NonRetryableError } from "cloudflare:workflows";
import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { createArtifactStorage } from "./artifact-storage.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";
import { operationTarget, registerCloudflareOperation } from "./cloudflare-operations.ts";
import { CloudflareApiError, createCloudflareProvisioner } from "./cloudflare-provisioning.ts";
import {
  CloudflareBindingUpdatePending,
  pendingCloudflareBindingMessage,
  updateCloudflareBindings,
} from "./cloudflare-binding-updates.ts";
import { deploymentCommand, hostedDeploymentId } from "./deployment-execution.ts";
import { DatabaseUnavailable, InvalidOperation } from "./errors.ts";
import {
  apps,
  artifacts,
  cloudflareOperations,
  deploymentEvents,
  deployments,
  runtimeReleases,
} from "./schema.ts";
import { createR2Storage } from "./storage/r2.ts";
import { transact } from "./transactions.ts";

const deploymentConfiguration = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  APP_RUNTIME_NAME: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  APP_RUNTIME_TOKEN: z.string().min(32),
});

const value = <T, E>(result: Result<T, E>) => {
  if (result.isErr()) throw result.error;

  return result.value;
};

export const createCloudflareDeployment = (bindings: CloudflareBindings, transport = fetch) => {
  const configuration = deploymentConfiguration.parse(bindings);
  const runtime = bindings.APP_RUNTIME;

  if (!runtime) throw new Error("The app runtime service binding is missing");

  const storage = createArtifactStorage(createR2Storage(bindings.ARTIFACTS));

  const provisioner = createCloudflareProvisioner(
    {
      accountId: configuration.CLOUDFLARE_ACCOUNT_ID,
      token: configuration.CLOUDFLARE_API_TOKEN,
      runtimeName: configuration.APP_RUNTIME_NAME,
    },
    transport,
  );

  const artifact = async (id: string) =>
    withCloudflareDatabase(bindings, async ({ db }) => {
      const [record] = await db.select().from(artifacts).where(eq(artifacts.id, id));

      if (!record) throw new Error("Deployment artifact not found");

      const parsed = contract.artifact.parse({
        id: record.id,
        appId: record.appId,
        metadata: record.metadata,
        manifest: record.manifest,
        modules: record.modules,
      });

      return parsed;
    });

  const immutable = async (key: string, body: string, customMetadata?: Record<string, string>) => {
    const written = await bindings.ARTIFACTS.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: customMetadata ?? {},
    });

    if (!written) {
      const existing = await bindings.ARTIFACTS.get(key);

      if (
        !existing ||
        (await existing.text()) !== body ||
        Object.entries(customMetadata ?? {}).some(
          ([name, expected]) => existing.customMetadata?.[name] !== expected,
        )
      )
        throw new Error("The immutable deployment snapshot contains different data");
    }
  };

  return {
    register: (command: z.infer<typeof deploymentCommand>) =>
      withCloudflareDatabase(bindings, async ({ db }) => {
        const record = value(await registerCloudflareOperation(db, storage, command));

        if (command.kind === "deploy" && (!record.finishedAt || record.error))
          await db
            .update(deployments)
            .set({ status: "running", finishedAt: null, message: null })
            .where(and(eq(deployments.id, command.id), ne(deployments.status, "succeeded")));

        return {
          sequence: record.sequence,
          targets: z.array(operationTarget).parse(record.targets),
        };
      }),
    provision: async (command: z.infer<typeof deploymentCommand>) => {
      if (command.kind !== "deploy") return {};

      return withCloudflareDatabase(bindings, ({ db }) =>
        db.transaction(async (transaction) => {
          // Serialize provisioning with removal admission. A resumed deployment
          // must not start new resource creation once removal has been accepted.
          const [app] = await transaction
            .select()
            .from(apps)
            .where(eq(apps.id, command.appId))
            .for("update");

          if (!app || app.state === "deleting")
            throw new InvalidOperation({
              code: "CONFLICT",
              message: "The app is no longer available for deployment",
            });
          const prepared = await provisioner.provision(await artifact(command.artifactId));
          await withCloudflareDatabase(bindings, ({ db: resources }) =>
            updateCloudflareBindings(resources, provisioner, prepared.resources),
          );

          return prepared.nativeBindings;
        }),
      );
    },
    activate: async (
      command: z.infer<typeof deploymentCommand>,
      target: z.infer<typeof operationTarget>,
      sequence: number,
      nativeBindings: Record<string, string>,
    ) =>
      withCloudflareDatabase(bindings, async ({ db }) =>
        value(
          await transact(db, async (transaction) => {
            const [app] = await transaction
              .select()
              .from(apps)
              .where(eq(apps.id, target.appId))
              .for("update");

            if (!app || app.state === "deleting")
              throw new InvalidOperation({
                code: "CONFLICT",
                message: "The app is no longer available for deployment",
              });

            const hostKey = `hosts/${app.hostname}.json`;
            const current = await bindings.ARTIFACTS.get(hostKey);
            const currentBody = current ? await current.text() : null;

            const entry = currentBody
              ? contract.publishedHost.parse(JSON.parse(currentBody))
              : null;

            const serving = entry && !("deleted" in entry) ? entry : null;

            const servingSequence = z.coerce
              .number()
              .int()
              .nonnegative()
              .parse(current?.customMetadata?.["widefleet_deployment_sequence"] ?? 0);

            if (serving && serving.appId !== app.id)
              throw new Error("The hostname belongs to another app");

            // Settings follow the version actually being served, even after a lost SQL commit.
            // An older deployment may retry, but must never replace newer code.
            if (command.kind === "deploy") {
              const [deployment] = await transaction
                .select()
                .from(deployments)
                .where(eq(deployments.id, command.id));

              if (deployment?.status === "succeeded") return Result.ok(undefined);

              if (servingSequence > sequence)
                throw new InvalidOperation({
                  code: "CONFLICT",
                  message: "A newer deployment has already been activated",
                });
            } else if (!serving) {
              if (command.kind === "capabilities") {
                const [publication] = await transaction
                  .select({ id: cloudflareOperations.id })
                  .from(cloudflareOperations)
                  .where(
                    and(
                      eq(cloudflareOperations.appId, app.id),
                      sql`${cloudflareOperations.command}->>'kind' = 'deploy'`,
                      // Older history without the marker cannot prove that no PUT started.
                      sql`${cloudflareOperations.targets}->0->>'publicationStarted' IS DISTINCT FROM 'false'`,
                    ),
                  )
                  .limit(1);

                // The app lock excludes a new publication attempt while confirming
                // saved changes. Failed readiness/provisioning cannot expose old grants.
                if (!publication)
                  await transaction
                    .update(apps)
                    .set({
                      appliedCapabilityRevision: app.capabilityRevision,
                      appliedCapabilities: {
                        revision: app.capabilityRevision,
                        grants: contract.capabilityGrants.parse(app.capabilities),
                      },
                      capabilityError: null,
                    })
                    .where(eq(apps.id, app.id));
              }

              return Result.ok(undefined);
            }

            const artifactId = command.kind === "deploy" ? command.artifactId : serving?.id;

            const [record] = artifactId
              ? await transaction.select().from(artifacts).where(eq(artifacts.id, artifactId))
              : [];

            if (!record) throw new Error("Deployment artifact not found");

            const access = contract.appAccessSnapshot.parse({
              revision: app.accessRevision,
              groups: app.accessGroups,
            });

            const network = contract.networkSnapshot.parse({
              revision: app.networkRevision,
              policy: app.networkPolicy,
            });

            const capabilities = contract.capabilitySnapshot.parse({
              revision: app.capabilityRevision,
              grants: app.capabilities,
            });

            checkCapabilityNames(
              contract.workerMetadata.parse(record.metadata),
              capabilities.grants,
            );

            // Entrypoint removal waits for confirmed revocation. The app lock is
            // sufficient here; unrelated apps can activate concurrently.
            const resolved = await resolveCloudflareCapabilities(
              transaction,
              app.fleetId,
              capabilities.grants,
            );

            if (resolved.bindings.length)
              await withCloudflareDatabase(bindings, ({ db: resources }) =>
                updateCloudflareBindings(resources, provisioner, resolved.bindings),
              );

            const selected = {
              id: record.id,
              appId: app.id,
              metadata: record.metadata,
              manifest: record.manifest,
              modules: record.modules,
              hostname: app.hostname,
              deploymentId: command.kind === "deploy" ? command.id : serving?.deploymentId,
              network,
              capabilities: resolved.capabilities,
              capabilityRevision: capabilities.revision,
              nativeBindings: command.kind === "deploy" ? nativeBindings : serving?.nativeBindings,
            };

            const version = hostedDeploymentId(command.id, JSON.stringify({ ...selected, access }));
            const published = contract.publishedApp.parse({ ...selected, version });
            const body = JSON.stringify(published);

            // Access groups can exceed R2's metadata limit; the immutable reference switches with code.
            const customMetadata = {
              widefleet_access: `access/${app.id}/${version}.json`,
              widefleet_deployment_sequence: String(
                command.kind === "deploy" ? sequence : servingSequence,
              ),
            };

            await immutable(customMetadata.widefleet_access, JSON.stringify(access));
            await immutable(`versions/${app.id}/${version}.json`, body, customMetadata);

            const response = await runtime.fetch(
              `https://${app.hostname}/.well-known/widefleet/ready`,
              {
                headers: {
                  authorization: `Bearer ${configuration.APP_RUNTIME_TOKEN}`,
                  "x-widefleet-candidate": `${app.id}/${version}`,
                },
                redirect: "manual",
              },
            );

            if (!response.ok) {
              await response.body?.cancel();
              throw new Error(`App readiness check failed (HTTP ${response.status})`);
            }

            const ready = z
              .object({
                deploymentId: z.literal(published.deploymentId),
                version: z.literal(version),
                networkRevision: z.literal(network.revision),
                capabilityRevision: z.literal(capabilities.revision),
                runtimeVersion: contract.runtimeVersion,
              })
              .parse(await response.json());

            // Runtime upgrades are independent of app deployments. A successful code
            // replacement can precede its SQL confirmation, so check the serving release.
            const [installed] = await transaction
              .select({ version: runtimeReleases.version })
              .from(runtimeReleases)
              .where(eq(runtimeReleases.version, ready.runtimeVersion));

            if (!installed) throw new Error("The active runtime release is not installed");

            const hasEvents =
              command.kind === "deploy" &&
              (published.metadata.crons.length ||
                published.metadata.queue_consumers.length ||
                serving?.metadata.crons.length ||
                serving?.metadata.queue_consumers.length ||
                (await createCloudflareEvents(
                  bindings.ARTIFACTS,
                  db,
                  provisioner,
                  configuration.APP_RUNTIME_NAME,
                ).registered(app.id)));

            // Subscription reservations must commit before their API write, independently
            // of the app transaction. Cloudflare database scopes use a single connection.
            if (hasEvents)
              await withCloudflareDatabase(bindings, ({ db: subscriptions }) =>
                createCloudflareEvents(
                  bindings.ARTIFACTS,
                  subscriptions,
                  provisioner,
                  configuration.APP_RUNTIME_NAME,
                ).stage(command.id, published, sequence),
              );

            if (hasEvents)
              await createCloudflareEvents(
                bindings.ARTIFACTS,
                db,
                provisioner,
                configuration.APP_RUNTIME_NAME,
              ).beginActivation(command.id, app.id);

            if (
              currentBody !== body ||
              current?.customMetadata?.["widefleet_access"] !== customMetadata.widefleet_access
            ) {
              if (command.kind === "deploy" && !current)
                await withCloudflareDatabase(bindings, async ({ db: history }) => {
                  const [operation] = await history
                    .select()
                    .from(cloudflareOperations)
                    .where(eq(cloudflareOperations.id, command.id));

                  if (!operation) throw new Error("Deployment operation history is missing");
                  // Commit before PUT, independently of the activation transaction. A
                  // timed-out first publication may still arrive after this lock is released.
                  await history
                    .update(cloudflareOperations)
                    .set({
                      targets: z
                        .array(operationTarget)
                        .parse(operation.targets)
                        .map((entry) =>
                          entry.appId === app.id ? { ...entry, publicationStarted: true } : entry,
                        ),
                    })
                    .where(eq(cloudflareOperations.id, command.id));
                });

              // CAS also protects against a timed-out PUT arriving after this SQL lock was released.
              const activated = await bindings.ARTIFACTS.put(hostKey, body, {
                onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
                httpMetadata: { contentType: "application/json" },
                customMetadata,
              });

              if (!activated) throw new Error("The active version changed during activation");
            }

            if (hasEvents)
              await withCloudflareDatabase(bindings, ({ db: subscriptions }) =>
                createCloudflareEvents(
                  bindings.ARTIFACTS,
                  subscriptions,
                  provisioner,
                  configuration.APP_RUNTIME_NAME,
                ).publish(published, sequence),
              );

            await transaction
              .update(apps)
              .set({
                activeDeploymentId: published.deploymentId,
                state: "active",
                appliedNetworkRevision: network.revision,
                networkError: null,
                appliedAccessRevision: access.revision,
                accessError: null,
                appliedCapabilities: capabilities,
                appliedCapabilityRevision: capabilities.revision,
                capabilityError: null,
              })
              .where(eq(apps.id, app.id));

            if (command.kind === "deploy") {
              await transaction
                .update(deployments)
                .set({
                  status: "succeeded",
                  finishedAt: new Date(),
                  message: "Cloudflare activated the deployment",
                })
                .where(eq(deployments.id, command.id));
              await transaction.insert(deploymentEvents).values({
                deploymentId: command.id,
                level: "info",
                message: "Cloudflare activated the deployment",
              });
            }

            return Result.ok(undefined);
          }),
        ),
      ),
    finish: (command: z.infer<typeof deploymentCommand>, error: string | null) =>
      withCloudflareDatabase(bindings, async ({ db }) => {
        return value(
          await transact(db, async (transaction) => {
            // Workflow step errors lose their custom type across durable execution.
            // Keep the unresolved resource update visible in CLI/API/UI deployment history.
            const pending =
              error && command.kind === "deploy"
                ? await pendingCloudflareBindingMessage(transaction, provisioner.scope)
                : null;

            const failure = pending ? `${error}. ${pending}` : error;

            const [record] = await transaction
              .update(cloudflareOperations)
              .set({ finishedAt: new Date(), error: failure })
              .where(eq(cloudflareOperations.id, command.id))
              .returning();

            if (!record || !failure) return Result.ok(undefined);

            if (command.kind === "deploy") {
              const [deployment] = await transaction
                .select()
                .from(deployments)
                .where(eq(deployments.id, command.id))
                .for("update");

              if (deployment && deployment.status !== "succeeded") {
                await transaction
                  .update(deployments)
                  .set({ status: "failed", finishedAt: new Date(), message: failure })
                  .where(eq(deployments.id, command.id));
                await transaction
                  .insert(deploymentEvents)
                  .values({ deploymentId: command.id, level: "error", message: failure });
              }
            }

            for (const target of z.array(operationTarget).parse(record.targets)) {
              const [app] = await transaction
                .select()
                .from(apps)
                .where(eq(apps.id, target.appId))
                .for("update");

              if (!app) continue;

              if (
                target.networkRevision === app.networkRevision &&
                app.appliedNetworkRevision !== target.networkRevision
              )
                await transaction
                  .update(apps)
                  .set({ networkError: failure })
                  .where(eq(apps.id, app.id));

              if (
                target.capabilityRevision === app.capabilityRevision &&
                app.appliedCapabilityRevision !== target.capabilityRevision
              )
                await transaction
                  .update(apps)
                  .set({ capabilityError: failure })
                  .where(eq(apps.id, app.id));

              if (
                target.accessRevision === app.accessRevision &&
                app.appliedAccessRevision !== target.accessRevision
              )
                await transaction
                  .update(apps)
                  .set({ accessError: failure })
                  .where(eq(apps.id, app.id));
            }

            return Result.ok(undefined);
          }),
        );
      }),
  };
};

export const retryable = async <T>(operation: () => Promise<T>) => {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof DatabaseUnavailable &&
      error.cause instanceof CloudflareSubscriptionPending
    )
      throw new Error(error.cause.message);

    if (error instanceof InvalidOperation) throw new NonRetryableError(error.message);

    if (
      error instanceof CloudflareApiError ||
      error instanceof CloudflareBindingUpdatePending ||
      error instanceof CloudflareSubscriptionPending
    )
      throw new Error(error.message);
    throw new Error("Cloudflare deployment step failed");
  }
};

export const executeCloudflareDeployment = async (
  bindings: CloudflareBindings,
  command: z.infer<typeof deploymentCommand>,
  step: CloudflareWorkersModule.WorkflowStep,
  transport = fetch,
) => {
  const runner = createCloudflareDeployment(bindings, transport);

  const options = {
    retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
    timeout: "2 minutes",
  } as const;

  try {
    const registration = await step.do("register-command", options, () =>
      retryable(() => runner.register(command)),
    );

    const nativeBindings = await step.do("provision-resources", options, () =>
      retryable(() => runner.provision(command)),
    );

    for (const target of registration.targets)
      await step.do(`activate-${target.appId}`, options, () =>
        retryable(() => runner.activate(command, target, registration.sequence, nativeBindings)),
      );

    await step.do("record-completion", options, () =>
      retryable(() => runner.finish(command, null)),
    );
  } catch (error) {
    const message =
      error instanceof InvalidOperation ||
      error instanceof CloudflareApiError ||
      (error instanceof Error && error.message.startsWith("Cloudflare subscription update "))
        ? error.message
        : "Cloudflare could not complete the deployment";

    await step.do("record-failure", options, () =>
      retryable(() => runner.finish(command, message)),
    );
    throw error;
  }
};
