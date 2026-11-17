import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { Result } from "better-result";
import { z } from "zod";
import { createArtifactStorage } from "./artifact-storage.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";
import { retryable } from "./cloudflare-deployment.ts";
import { CloudflareApiError, createCloudflareProvisioner } from "./cloudflare-provisioning.ts";
import type { cloudflareRuntimeCommand } from "./cloudflare-runtime-command.ts";
import {
  cloudflareRuntimeUpload,
  readCloudflareRuntimeVersion,
} from "./cloudflare-runtime-package.ts";
import { registerCloudflareRuntime } from "./cloudflare-runtime-releases.ts";
import { InvalidOperation } from "./errors.ts";
import { lockOrganizationRuntime } from "./organization-runtime.ts";
import { loadRuntime } from "./runtime-releases.ts";
import { cloudflareOperations, organizationRuntimes } from "./schema.ts";
import { createR2Storage } from "./storage/r2.ts";

export const executeCloudflareRuntime = async (
  bindings: CloudflareBindings,
  command: z.infer<typeof cloudflareRuntimeCommand>,
  step: CloudflareWorkersModule.WorkflowStep,
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

  const options = {
    retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
    timeout: "2 minutes",
  } as const;

  const fail = (message: string) =>
    withCloudflareDatabase(bindings, async ({ db }) => {
      await db
        .update(cloudflareOperations)
        .set({ finishedAt: new Date(), error: message })
        .where(
          and(eq(cloudflareOperations.id, command.id), isNull(cloudflareOperations.finishedAt)),
        );
    });

  const apply = async (confirm: boolean) => {
    try {
      await withCloudflareDatabase(bindings, ({ db }) =>
        db.transaction(async (transaction) => {
          // Reuse the execution lock used by runtime selection and connection changes.
          const execution = await lockOrganizationRuntime(transaction, command.organizationId);

          const [operation] = await transaction
            .select()
            .from(cloudflareOperations)
            .where(eq(cloudflareOperations.id, command.id));

          if (!operation) throw new Error("Runtime operation history is missing");

          if (operation.finishedAt && !operation.error) return;

          if (execution.runtimeJobId !== command.id)
            throw new InvalidOperation({
              code: "CONFLICT",
              message: "A newer runtime update superseded this operation",
            });

          if (confirm) {
            const version = await readCloudflareRuntimeVersion(bindings);

            if (version !== command.runtime.version)
              throw new Error("The requested runtime version is not active");
            await transaction
              .update(organizationRuntimes)
              .set({ appliedRuntime: command.runtime })
              .where(eq(organizationRuntimes.organizationId, execution.organizationId));
            await transaction
              .update(cloudflareOperations)
              .set({ finishedAt: new Date(), error: null })
              .where(eq(cloudflareOperations.id, command.id));
          } else {
            const active = await Result.tryPromise(() => readCloudflareRuntimeVersion(bindings));

            if (active.isOk() && active.value === command.runtime.version) return;
            const { runtime } = await loadRuntime(storage, command.runtime);

            // Cloudflare's content endpoint preserves settings and metadata, including
            // bindings added concurrently by app deployments and their confirmation tags.
            // A timeout does not cancel the provider's write. This lock orders local
            // attempts; it cannot fence a provider write that finishes after disconnect.
            try {
              await provisioner.call("upload runtime Worker", () =>
                provisioner.client.workers.scripts.content.update(
                  configuration.APP_RUNTIME_NAME,
                  { ...provisioner.account, metadata: { main_module: runtime.main } },
                  // Preserve JSON metadata and module names in multipart uploads.
                  { body: Object.fromEntries(cloudflareRuntimeUpload(runtime)) },
                ),
              );
            } catch (error) {
              if (
                error instanceof CloudflareApiError &&
                [400, 401, 403, 404, 413, 415, 422].includes(error.status)
              )
                throw new InvalidOperation({
                  code: "BAD_REQUEST",
                  message: `Cloudflare rejected the runtime update (HTTP ${error.status})`,
                });
              throw error;
            }
          }
        }),
      );
    } catch (error) {
      // Preserve a known rejection before the Workflow serializes its exception.
      if (error instanceof InvalidOperation) await fail(error.message);
      throw error;
    }
  };

  try {
    await step.do("register-runtime", options, () =>
      retryable(() =>
        withCloudflareDatabase(bindings, async ({ db }) => {
          const registered = await registerCloudflareRuntime(db, storage, command);

          if (registered.isErr()) throw registered.error;
          await db
            .update(cloudflareOperations)
            .set({ finishedAt: null, error: null })
            .where(
              and(eq(cloudflareOperations.id, command.id), isNotNull(cloudflareOperations.error)),
            );
        }),
      ),
    );
    await step.do("replace-runtime-code", options, () => retryable(() => apply(false)));
    await step.do("confirm-runtime", options, () => retryable(() => apply(true)));
  } catch (error) {
    await step.do("record-runtime-failure", options, () =>
      fail("Cloudflare could not complete the runtime update"),
    );
    throw error;
  }
};
