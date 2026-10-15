import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import * as contract from "@platform/contracts";
import type { CloudflareBindings } from "./lib/server/cloudflare-config.ts";
import { cloudflareAppOperation } from "./lib/server/cloudflare-app-operation-command.ts";
import { registerCloudflareAppOperation } from "./lib/server/cloudflare-app-operations.ts";
import { withCloudflareDatabase } from "./lib/server/cloudflare-database.ts";
import { cloudflareOperations } from "./lib/server/schema.ts";
import {
  createCloudflareProvisioner,
  cloudflareResourceName,
} from "./lib/server/cloudflare-provisioning.ts";
import { runCloudflareMigrations } from "./lib/server/cloudflare-migrations.ts";
import { apps } from "./lib/server/schema.ts";
import { executeCloudflareRemoval } from "./lib/server/cloudflare-removal.ts";
import { InvalidOperation } from "./lib/server/errors.ts";

export class AppOperationWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  z.infer<typeof cloudflareAppOperation>
> {
  override async run(
    event: CloudflareWorkersModule.WorkflowEvent<z.infer<typeof cloudflareAppOperation>>,
    step: CloudflareWorkersModule.WorkflowStep,
  ) {
    const command = cloudflareAppOperation.parse(event.payload);

    if (event.instanceId !== command.id)
      throw new NonRetryableError("App operation identity does not match its command");

    if (command.kind === "remove") {
      await executeCloudflareRemoval(this.env, command, step);

      return;
    }

    const options = {
      retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
      timeout: "2 minutes",
    } as const;

    const finish = (result: z.infer<ReturnType<typeof z.json>>, error: string | null) =>
      withCloudflareDatabase(this.env, async ({ db }) => {
        await db
          .update(cloudflareOperations)
          .set({ result: { value: result }, error, finishedAt: new Date() })
          .where(
            and(
              eq(cloudflareOperations.id, command.id),
              eq(cloudflareOperations.appId, command.appId),
              sql`${cloudflareOperations.command} = ${JSON.stringify(command)}::jsonb`,
              error === null ? undefined : isNull(cloudflareOperations.finishedAt),
            ),
          );
      });

    const execute = async () => {
      const app = await withCloudflareDatabase(this.env, async ({ db }) => {
        const [record] = await db.select().from(apps).where(eq(apps.id, command.appId));

        if (!record || record.state === "deleting")
          throw new NonRetryableError("App is not available");

        return record;
      });

      const object = await this.env.ARTIFACTS.get(`hosts/${app.hostname}.json`);

      if (!object) throw new NonRetryableError("App is not published");
      const published = contract.publishedApp.parse(await object.json());

      if (published.appId !== command.appId)
        throw new NonRetryableError("Hostname belongs to another app");

      if (command.kind === "workflows") {
        if (!this.env.APP_RUNTIME || !this.env.APP_RUNTIME_TOKEN)
          throw new Error("App runtime is not configured");

        const response = await this.env.APP_RUNTIME.fetch(
          `https://${app.hostname}/.well-known/widefleet/workflows`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.env.APP_RUNTIME_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              appId: command.appId,
              hostname: app.hostname,
              requestId: command.id,
              request: command.request,
            }),
            redirect: "manual",
          },
        );

        if (!response.ok) {
          const error = z.object({ error: z.string() }).parse(await response.json());

          if (response.status >= 400 && response.status < 500)
            throw new NonRetryableError(error.error);
          throw new Error("App workflow operation failed");
        }

        return z.object({ result: z.json() }).parse(await response.json()).result;
      }

      const source = await this.env.ARTIFACTS.get(
        `apps/${command.appId}/migrations/${command.migration.sha256}`,
      );

      if (!source) throw new NonRetryableError("Migration artifact is missing");
      const bytes = await source.arrayBuffer();

      if (
        bytes.byteLength !== command.migration.size ||
        createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !==
          command.migration.sha256
      )
        throw new NonRetryableError("Migration artifact checksum mismatch");
      const input = contract.migrationRequest.parse(JSON.parse(new TextDecoder().decode(bytes)));

      const binding = published.metadata.bindings.find(
        (entry) => entry.name === input.database && entry.type === "d1",
      );

      if (
        binding?.type !== "d1" ||
        (binding.database_id ?? binding.database_name) !== input.databaseId
      )
        throw new NonRetryableError("The selected database does not match the deployed D1 binding");

      const configuration = z
        .object({
          CLOUDFLARE_ACCOUNT_ID: z.string(),
          CLOUDFLARE_API_TOKEN: z.string(),
          APP_RUNTIME_NAME: z.string(),
        })
        .parse(this.env);

      const provisioner = createCloudflareProvisioner({
        accountId: configuration.CLOUDFLARE_ACCOUNT_ID,
        token: configuration.CLOUDFLARE_API_TOKEN,
        runtimeName: configuration.APP_RUNTIME_NAME,
      });

      const name = cloudflareResourceName(command.appId, "d1", input.databaseId);

      if (published.nativeBindings[input.database] !== `B_${name}`)
        throw new NonRetryableError("The deployed database binding is invalid");
      const databaseId = await provisioner.findDatabase(name);

      if (!databaseId) throw new NonRetryableError("The deployed database does not exist");

      return runCloudflareMigrations(provisioner, databaseId, input);
    };

    try {
      await step.do("register-operation", options, async () => {
        const record = await withCloudflareDatabase(this.env, async ({ db }) => {
          const registered = await registerCloudflareAppOperation(db, command);

          if (registered.isOk() && registered.value.error !== null)
            await db
              .update(cloudflareOperations)
              .set({ finishedAt: null, error: null, result: { value: null } })
              .where(eq(cloudflareOperations.id, command.id));

          return registered;
        });

        if (record.isErr()) {
          if (record.error instanceof InvalidOperation) {
            await finish(null, record.error.message);
            throw new NonRetryableError(record.error.message);
          }

          throw record.error;
        }
      });

      await step.do("execute-operation", options, async () => {
        const completed = await withCloudflareDatabase(this.env, async ({ db }) => {
          const [record] = await db
            .select()
            .from(cloudflareOperations)
            .where(eq(cloudflareOperations.id, command.id));

          return record?.finishedAt && record.error === null;
        });

        // Store results directly in history: app Workflow output must not be
        // serialized a second time into the management Workflow's step limit.
        // A lost checkpoint acknowledgement reuses this confirmed outcome.
        if (!completed) {
          try {
            await finish(await execute(), null);
          } catch (error) {
            // These messages originate from validation or the authenticated
            // runtime, never from raw Cloudflare provisioning responses.
            if (error instanceof NonRetryableError || error instanceof InvalidOperation)
              await finish(null, error.message);
            throw error;
          }
        }
      });
    } catch (error) {
      await step.do("record-failure", options, () =>
        finish(null, "Cloudflare could not complete the app operation"),
      );
      throw error;
    }
  }
}
