import { requireAvailableHostname } from "./hostnames.ts";
import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import {
  connectorActivation,
  connectorManagement,
  connectorPreparation,
  connectorBrowserOrigin,
} from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createArtifactStorage } from "./artifact-storage.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";
import { registerCloudflareConnector } from "./cloudflare-connectors.ts";
import type { connectorCommand } from "./cloudflare-connector-command.ts";
import { provisionConnectorResources } from "./cloudflare-connector-package.ts";
import { connectorReference, loadConnector } from "./connector-package.ts";
import { createCloudflareProvisioner } from "./cloudflare-provisioning.ts";
import { updateCloudflareBindings } from "./cloudflare-binding-updates.ts";
import { retryable } from "./cloudflare-deployment.ts";
import { InvalidOperation } from "./errors.ts";
import { lockOrganizationRuntime } from "./organization-runtime.ts";
import type { DatabaseExecutor } from "./database.ts";
import { cloudflareOperations, connectors } from "./schema.ts";
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

  const manage = async (input: z.input<typeof connectorManagement>) => {
    if (!bindings.APP_RUNTIME) throw new Error("App runtime is not configured");

    const response = await bindings.APP_RUNTIME.fetch(
      "https://runtime.internal/.well-known/widefleet/connectors",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Runtime could not complete connector activation");
    }

    return z.object({ result: connectorActivation }).parse(await response.json()).result;
  };

  const accepted = async (db: DatabaseExecutor, command: z.infer<typeof connectorCommand>) => {
    const [record] = await db
      .select()
      .from(cloudflareOperations)
      .where(
        and(
          eq(cloudflareOperations.id, command.id),
          eq(cloudflareOperations.organizationId, command.organizationId),
        ),
      );

    if (!record || !isDeepStrictEqual(record.command, command))
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "Connector command does not match its accepted operation",
      });

    return connectorReference.parse(record.result);
  };

  return {
    register: (command: z.infer<typeof connectorCommand>) =>
      withCloudflareDatabase(bindings, async ({ db }) => {
        (await registerCloudflareConnector(db, storage, command, bindings)).unwrap();
      }),
    provision: async (command: z.infer<typeof connectorCommand>) => {
      const prepared = await provisionConnectorResources(
        provisioner,
        command.organizationId,
        await loadConnector(
          storage,
          await withCloudflareDatabase(bindings, ({ db }) => accepted(db, command)),
        ),
      );

      await withCloudflareDatabase(bindings, ({ db }) =>
        updateCloudflareBindings(db, provisioner, prepared.resources),
      );

      return prepared.nativeBindings;
    },
    activate: (command: z.infer<typeof connectorCommand>, nativeBindings: Record<string, string>) =>
      withCloudflareDatabase(bindings, async ({ db }) =>
        (
          await transact(db, async (transaction) => {
            const execution = await lockOrganizationRuntime(
              transaction,
              command.actor.application.organizationId,
            );

            await accepted(transaction, command);

            const [record] = await transaction
              .select()
              .from(connectors)
              .where(
                and(
                  eq(connectors.organizationId, command.organizationId),
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
            const secrets: Record<string, string> = {};

            for (const [name, ciphertext] of Object.entries(selected.secrets))
              secrets[name] = await decryptSecret(bindings.PLATFORM_ENCRYPTION_KEY, ciphertext);

            const browserOrigin = connectorBrowserOrigin(
              release.name,
              execution.appHostnameSuffix,
              bindings.APP_DOMAIN,
            );

            await requireAvailableHostname(
              transaction,
              new URL(browserOrigin).hostname,
              bindings.APP_DOMAIN,
              { organizationId: command.organizationId, name: release.name },
            );

            // Plaintext only crosses the private management binding. The runtime encrypts
            // the immutable snapshot; Workflow results and SQL receipts contain IDs only.
            const preparation: z.input<typeof connectorPreparation> = {
              organizationId: command.organizationId,
              version: command.id,
              release,
              nativeBindings,
              secrets,
              telemetry: null,
              browserOrigin,
            };

            const prepared = await manage({ action: "prepare", ...preparation });

            await manage({ action: "activate", ...prepared });
            await transaction
              .update(connectors)
              .set({ appliedPackage: selected })
              .where(
                and(
                  eq(connectors.organizationId, command.organizationId),
                  eq(connectors.name, selected.name),
                ),
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
        await db
          .update(cloudflareOperations)
          .set({ finishedAt: new Date(), error })
          .where(
            and(
              eq(cloudflareOperations.id, command.id),
              eq(cloudflareOperations.organizationId, command.organizationId),
              eq(cloudflareOperations.command, command),
              isNull(cloudflareOperations.finishedAt),
            ),
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
