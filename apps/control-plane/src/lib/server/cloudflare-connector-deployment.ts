import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createArtifactStorage } from "./artifact-storage.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";
import { registerCloudflareConnector } from "./cloudflare-connectors.ts";
import type { connectorCommand } from "./cloudflare-connector-command.ts";
import {
  connectorWorkerName,
  connectorUpload,
  provisionConnectorResources,
} from "./cloudflare-connector-package.ts";
import { connectorReference, loadConnector } from "./connector-package.ts";
import { CloudflareApiError, createCloudflareProvisioner } from "./cloudflare-provisioning.ts";
import { updateCloudflareSubscription } from "./cloudflare-subscription-updates.ts";
import { retryable } from "./cloudflare-deployment.ts";
import { InvalidOperation } from "./errors.ts";
import { lockFleet } from "./fleets.ts";
import { cloudflareOperations, cloudflareSubscriptionUpdates, connectors } from "./schema.ts";
import { decryptSecret } from "./secret-encryption.ts";
import { createR2Storage } from "./storage/r2.ts";
import { transact } from "./transactions.ts";

export const createCloudflareConnectorDeployment = (
  bindings: CloudflareBindings,
  transport = fetch,
) => {
  const configuration = z
    .object({
      CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
      CLOUDFLARE_API_TOKEN: z.string().min(1),
      APP_RUNTIME_NAME: z.string().min(1),
    })
    .parse(bindings);

  const provisioner = createCloudflareProvisioner(
    {
      accountId: configuration.CLOUDFLARE_ACCOUNT_ID,
      token: configuration.CLOUDFLARE_API_TOKEN,
      runtimeName: configuration.APP_RUNTIME_NAME,
    },
    transport,
  );

  const storage = createArtifactStorage(createR2Storage(bindings.ARTIFACTS));

  const reference = (command: z.infer<typeof connectorCommand>) =>
    withCloudflareDatabase(bindings, async ({ db }) => {
      const [record] = await db
        .select()
        .from(cloudflareOperations)
        .where(eq(cloudflareOperations.id, command.id));

      if (!record) throw new Error("Connector operation history is missing");

      return connectorReference.parse(record.result);
    });

  return {
    register: (command: z.infer<typeof connectorCommand>) =>
      withCloudflareDatabase(bindings, async ({ db }) => {
        (await registerCloudflareConnector(db, storage, command)).unwrap();
      }),
    provision: async (command: z.infer<typeof connectorCommand>) =>
      provisionConnectorResources(
        provisioner,
        command.fleetId,
        await loadConnector(storage, await reference(command)),
      ),
    activate: (
      command: z.infer<typeof connectorCommand>,
      resources: Awaited<ReturnType<typeof provisionConnectorResources>>,
    ) =>
      withCloudflareDatabase(bindings, async ({ db }) =>
        (
          await transact(db, async (transaction) => {
            // The same lock serializes desired edits, connector activation and app grants.
            await lockFleet(transaction, command.fleetId);

            const [record] = await transaction
              .select()
              .from(connectors)
              .where(
                and(
                  eq(connectors.fleetId, command.fleetId),
                  eq(connectors.name, command.change.name),
                ),
              );

            if (!record || record.jobId !== command.id)
              throw new InvalidOperation({
                code: "CONFLICT",
                message: "A newer connector change superseded this operation",
              });
            const selected = connectorReference.parse(record.package);
            const release = await loadConnector(storage, selected);

            const workerName = connectorWorkerName(command.fleetId, selected.name);
            const path = `/workers/scripts/${encodeURIComponent(workerName)}`;
            let deployedVersion: string | null = null;

            const readVersion = async () => {
              try {
                const current = z
                  .object({
                    annotations: z.object({ "workers/tag": z.uuid() }),
                  })
                  .parse(await provisioner.request(`${path}/settings`));

                deployedVersion = current.annotations["workers/tag"];

                return deployedVersion;
              } catch (error) {
                if (error instanceof CloudflareApiError && error.status === 404) return null;
                throw error;
              }
            };

            let upload: FormData | undefined;

            await withCloudflareDatabase(bindings, ({ db: reservations }) =>
              updateCloudflareSubscription(
                reservations,
                `${configuration.CLOUDFLARE_ACCOUNT_ID}/connector/${workerName}`,
                z.string().nullable(),
                readVersion,
                async () => {
                  if (deployedVersion) {
                    // The native annotation identifies the live package even when its
                    // upload acknowledgement or SQL activation receipt was lost.
                    const [deployed] = await transaction
                      .select()
                      .from(cloudflareOperations)
                      .where(
                        and(
                          eq(cloudflareOperations.id, deployedVersion),
                          eq(cloudflareOperations.fleetId, command.fleetId),
                        ),
                      );

                    const previous = connectorReference.parse(deployed?.result);

                    if (previous.name !== selected.name)
                      throw new Error("Deployed connector identity mismatch");

                    const history = (await loadConnector(storage, previous)).configuration
                      .migrations;

                    if (
                      !isDeepStrictEqual(
                        history,
                        release.configuration.migrations.slice(0, history.length),
                      )
                    )
                      throw new InvalidOperation({
                        code: "CONFLICT",
                        message: "Deployed connector migrations cannot be changed or removed",
                      });
                  }

                  let migrationTag: string | null = null;

                  try {
                    const service = z
                      .object({
                        default_environment: z.object({
                          script: z.object({ migration_tag: z.string().nullish() }),
                        }),
                      })
                      .parse(
                        await provisioner.request(
                          `/workers/services/${encodeURIComponent(workerName)}`,
                        ),
                      );

                    migrationTag = service.default_environment.script.migration_tag ?? null;
                  } catch (error) {
                    if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
                  }

                  const secrets: Record<string, string> = {};

                  for (const [name, ciphertext] of Object.entries(selected.secrets))
                    secrets[name] = await decryptSecret(
                      bindings.PLATFORM_ENCRYPTION_KEY,
                      ciphertext,
                    );
                  // Code, configuration and secrets become active in one upload. Plaintext never
                  // leaves this invocation as a Workflow step result or operation-history value.
                  upload = connectorUpload(
                    command.id,
                    workerName,
                    release,
                    resources,
                    secrets,
                    migrationTag,
                  );

                  return command.id;
                },
                async () => {
                  if (!upload) throw new Error("Connector upload was not prepared");
                  await provisioner.request(path, { method: "PUT", body: upload });
                },
              ),
            );
            // The default module always returns 404, including before these URL settings apply.
            await provisioner.request(`${path}/subdomain`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "Cloudflare-Workers-Script-Api-Date": "2025-08-01",
              },
              body: JSON.stringify({ enabled: false, previews_enabled: false }),
            });
            await transaction
              .update(connectors)
              .set({ appliedPackage: selected })
              .where(
                and(eq(connectors.fleetId, command.fleetId), eq(connectors.name, selected.name)),
              );
            await transaction
              .update(cloudflareOperations)
              .set({ finishedAt: new Date(), error: null })
              .where(eq(cloudflareOperations.id, command.id));

            return Result.ok(undefined);
          })
        ).unwrap(),
      ),
    fail: (command: z.infer<typeof connectorCommand>, error: string) =>
      withCloudflareDatabase(bindings, async ({ db }) => {
        const workerName = connectorWorkerName(command.fleetId, command.change.name);

        const [state] = await db
          .select()
          .from(cloudflareSubscriptionUpdates)
          .where(
            eq(
              cloudflareSubscriptionUpdates.scope,
              `${configuration.CLOUDFLARE_ACCOUNT_ID}/connector/${workerName}`,
            ),
          );

        const pending = state?.pending ? z.object({ id: z.string() }).parse(state.pending) : null;

        const message = pending
          ? `Cloudflare connector update ${pending.id} is unconfirmed. Further changes to this connector are blocked until its outcome is verified.`
          : error;

        await db
          .update(cloudflareOperations)
          .set({ finishedAt: new Date(), error: message })
          .where(
            and(eq(cloudflareOperations.id, command.id), isNull(cloudflareOperations.finishedAt)),
          );
      }),
  };
};

export const executeCloudflareConnector = async (
  bindings: CloudflareBindings,
  command: z.infer<typeof connectorCommand>,
  step: CloudflareWorkersModule.WorkflowStep,
  transport = fetch,
) => {
  const runner = createCloudflareConnectorDeployment(bindings, transport);

  const options = {
    retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
    timeout: "2 minutes",
  } as const;

  try {
    await step.do("register-connector", options, () => retryable(() => runner.register(command)));

    const resources = await step.do("provision-connector-resources", options, () =>
      retryable(() => runner.provision(command)),
    );

    await step.do("activate-connector", options, () =>
      retryable(() => runner.activate(command, resources)),
    );
  } catch (error) {
    await step.do("record-connector-failure", options, () =>
      retryable(() =>
        runner.fail(command, "Cloudflare could not complete the connector deployment"),
      ),
    );
    throw error;
  }
};
