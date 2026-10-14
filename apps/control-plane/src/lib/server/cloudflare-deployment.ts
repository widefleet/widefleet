import { NonRetryableError } from "cloudflare:workflows";
import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { createArtifactStorage } from "./artifact-storage.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";
import {
  operationTarget,
  registerCloudflareOperation,
  validateCloudflareArtifact,
} from "./cloudflare-operations.ts";
import { CloudflareApiError, createCloudflareProvisioner } from "./cloudflare-provisioning.ts";
import { deploymentCommand, hostedDeploymentId } from "./deployment-execution.ts";
import { InvalidOperation } from "./errors.ts";
import { lockFleet } from "./fleets.ts";
import { apps, artifacts, cloudflareOperations, deploymentEvents, deployments } from "./schema.ts";
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

      validateCloudflareArtifact(parsed);

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

      return provisioner.provision(await artifact(command.artifactId), (operation) =>
        withCloudflareDatabase(bindings, async ({ db }) =>
          value(
            await transact(db, async (transaction) => {
              const [app] = await transaction.select().from(apps).where(eq(apps.id, command.appId));

              if (!app) throw new Error("Deployment app not found");

              // Only the read/modify/write of shared Worker bindings needs this installation lock.
              // Native Workflows still own scheduling, retries and all other execution steps.
              await lockFleet(transaction, app.fleetId);
              await operation();

              return Result.ok(undefined);
            }),
          ),
        ),
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

            const serving = currentBody
              ? contract.publishedApp.parse(JSON.parse(currentBody))
              : null;

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
            } else if (!serving) return Result.ok(undefined);

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

            if (Object.keys(capabilities.grants).length)
              throw new InvalidOperation({
                code: "BAD_REQUEST",
                message: "Cloudflare connector deployment is not available yet",
              });

            const selected = {
              id: record.id,
              appId: app.id,
              metadata: record.metadata,
              manifest: record.manifest,
              modules: record.modules,
              hostname: app.hostname,
              deploymentId: command.kind === "deploy" ? command.id : serving?.deploymentId,
              network,
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

            z.object({
              deploymentId: z.literal(published.deploymentId),
              version: z.literal(version),
              networkRevision: z.literal(network.revision),
              capabilityRevision: z.literal(capabilities.revision),
              runtimeVersion: z.literal(target.runtime.version),
            }).parse(await response.json());

            if (
              currentBody !== body ||
              current?.customMetadata?.["widefleet_access"] !== customMetadata.widefleet_access
            ) {
              // CAS also protects against a timed-out PUT arriving after this SQL lock was released.
              const activated = await bindings.ARTIFACTS.put(hostKey, body, {
                onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
                httpMetadata: { contentType: "application/json" },
                customMetadata,
              });

              if (!activated) throw new Error("The active version changed during activation");
            }

            await transaction
              .update(apps)
              .set({
                activeDeploymentId: published.deploymentId,
                state: "active",
                appliedNetworkRevision: network.revision,
                networkError: null,
                appliedAccessRevision: access.revision,
                accessError: null,
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
      withCloudflareDatabase(bindings, async ({ db }) =>
        value(
          await transact(db, async (transaction) => {
            const [record] = await transaction
              .update(cloudflareOperations)
              .set({ finishedAt: new Date(), error })
              .where(eq(cloudflareOperations.id, command.id))
              .returning();

            if (!record || !error) return Result.ok(undefined);

            if (command.kind === "deploy") {
              const [deployment] = await transaction
                .select()
                .from(deployments)
                .where(eq(deployments.id, command.id))
                .for("update");

              if (deployment && deployment.status !== "succeeded") {
                await transaction
                  .update(deployments)
                  .set({ status: "failed", finishedAt: new Date(), message: error })
                  .where(eq(deployments.id, command.id));
                await transaction
                  .insert(deploymentEvents)
                  .values({ deploymentId: command.id, level: "error", message: error });
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
                  .set({ networkError: error })
                  .where(eq(apps.id, app.id));

              if (
                target.accessRevision === app.accessRevision &&
                app.appliedAccessRevision !== target.accessRevision
              )
                await transaction
                  .update(apps)
                  .set({ accessError: error })
                  .where(eq(apps.id, app.id));
            }

            return Result.ok(undefined);
          }),
        ),
      ),
  };
};

const retryable = async <T>(operation: () => Promise<T>) => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof InvalidOperation) throw new NonRetryableError(error.message);

    if (error instanceof CloudflareApiError) throw new Error(error.message);
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
      error instanceof InvalidOperation || error instanceof CloudflareApiError
        ? error.message
        : "Cloudflare could not complete the deployment";

    await step.do("record-failure", options, () =>
      retryable(() => runner.finish(command, message)),
    );
    throw error;
  }
};
