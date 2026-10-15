import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import * as contract from "@platform/contracts";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";
import { registerCloudflareRemoval } from "./cloudflare-removal-admission.ts";
import { cloudflareRemovalCommand, removalTarget } from "./cloudflare-removal-command.ts";
import { removalResources, removeCloudflareResource } from "./cloudflare-removal-resources.ts";
import { createCloudflareProvisioner } from "./cloudflare-provisioning.ts";
import { updateCloudflareBindings } from "./cloudflare-binding-updates.ts";
import { createCloudflareEvents } from "./cloudflare-events.ts";
import { retryable } from "./cloudflare-deployment.ts";
import { apps, artifacts, cloudflareOperations } from "./schema.ts";
import { InvalidOperation } from "./errors.ts";

export const createCloudflareRemover = (bindings: CloudflareBindings, transport = fetch) => {
  const configuration = z
    .object({
      CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
      CLOUDFLARE_API_TOKEN: z.string().min(1),
      APP_RUNTIME_NAME: z.string().min(1),
      APP_RUNTIME_TOKEN: z.string().min(32),
    })
    .parse(bindings);

  const runtime = bindings.APP_RUNTIME;

  if (!runtime) throw new Error("App runtime binding is missing");

  const provisioner = createCloudflareProvisioner(
    {
      accountId: configuration.CLOUDFLARE_ACCOUNT_ID,
      token: configuration.CLOUDFLARE_API_TOKEN,
      runtimeName: configuration.APP_RUNTIME_NAME,
    },
    transport,
  );

  return {
    register: (command: z.infer<typeof cloudflareRemovalCommand>) =>
      withCloudflareDatabase(bindings, async ({ db }) =>
        (await registerCloudflareRemoval(db, command)).unwrap(),
      ),
    unpublish: (target: z.infer<typeof removalTarget>) =>
      withCloudflareDatabase(bindings, ({ db }) =>
        db.transaction(async (transaction) => {
          const [app] = await transaction
            .select()
            .from(apps)
            .where(eq(apps.id, target.id))
            .for("update");

          if (!app) return false;

          if (app.state !== "deleting" || app.hostname !== target.hostname)
            throw new InvalidOperation({
              code: "CONFLICT",
              message: "App is not marked for removal",
            });
          const key = `hosts/${target.hostname}.json`;
          const current = await bindings.ARTIFACTS.get(key);
          const entry = current ? contract.publishedHost.parse(await current.json()) : null;

          if (entry && !("deleted" in entry) && entry.appId !== target.id)
            throw new Error("Hostname belongs to another app");

          if (entry && "deleted" in entry && entry.appId === target.id) return true;

          // Keep this fence after cleanup. Removing the key would allow a delayed
          // first publication (If-None-Match: *) to resurrect the deleted app.
          const written = await bindings.ARTIFACTS.put(
            key,
            JSON.stringify(contract.deletedApp.parse({ deleted: true, appId: target.id })),
            {
              onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
              httpMetadata: { contentType: "application/json" },
            },
          );

          if (!written) throw new Error("App publication changed during removal");

          return true;
        }),
      ),
    events: (target: z.infer<typeof removalTarget>) =>
      withCloudflareDatabase(bindings, ({ db }) =>
        createCloudflareEvents(
          bindings.ARTIFACTS,
          db,
          provisioner,
          configuration.APP_RUNTIME_NAME,
        ).remove(target.id, target.hostname),
      ),
    purgeWorkflows: async (target: z.infer<typeof removalTarget>, id: string) => {
      const response = await runtime.fetch(
        `https://${target.hostname}/.well-known/widefleet/workflows`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${configuration.APP_RUNTIME_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            appId: target.id,
            hostname: target.hostname,
            requestId: id,
            request: { action: "purge" },
          }),
        },
      );

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Could not purge app workflows");
      }

      return z.object({ result: z.object({ done: z.boolean() }) }).parse(await response.json())
        .result.done;
    },
    inventory: (appId: string) =>
      withCloudflareDatabase(bindings, async ({ db }) => {
        const resources = new Map<string, ReturnType<typeof removalResources>[number]>();
        let after: string | undefined;

        for (;;) {
          const records = await db
            .select({ id: artifacts.id, metadata: artifacts.metadata })
            .from(artifacts)
            .where(and(eq(artifacts.appId, appId), after ? gt(artifacts.id, after) : undefined))
            .orderBy(artifacts.id)
            .limit(100);

          for (const record of records)
            for (const resource of removalResources(appId, [
              contract.workerMetadata.parse(record.metadata),
            ]))
              resources.set(resource.name, resource);

          if (records.length < 100) return [...resources.values()];
          after = records.at(-1)?.id;
        }
      }),
    detach: (names: string[]) =>
      withCloudflareDatabase(bindings, ({ db }) =>
        updateCloudflareBindings(
          db,
          provisioner,
          [],
          names.map((name) => `B_${name}`),
        ),
      ),
    resource: (resource: Parameters<typeof removeCloudflareResource>[1]) =>
      removeCloudflareResource(provisioner, resource),
    storage: async (prefix: string) => {
      const page = await bindings.ARTIFACTS.list({ prefix, limit: 1000 });

      if (page.objects.length)
        await bindings.ARTIFACTS.delete(page.objects.map((object) => object.key));

      return page.objects.length === 0;
    },
    finishApp: (appId: string) =>
      withCloudflareDatabase(bindings, ({ db }) =>
        db.transaction(async (transaction) => {
          const [app] = await transaction
            .select()
            .from(apps)
            .where(eq(apps.id, appId))
            .for("update");

          if (!app) return;

          if (app.state !== "deleting") throw new Error("App is no longer marked for removal");

          const [child] = await transaction
            .select({ id: apps.id })
            .from(apps)
            .where(eq(apps.parentId, appId))
            .limit(1);

          if (child) throw new Error("App previews have not finished removal");
          await transaction.delete(apps).where(eq(apps.id, appId));
        }),
      ),
    fail: (id: string, message: string) =>
      withCloudflareDatabase(bindings, async ({ db }) => {
        await db
          .update(cloudflareOperations)
          .set({ error: message, finishedAt: new Date() })
          .where(eq(cloudflareOperations.id, id));
      }),
  };
};

export const executeCloudflareRemoval = async (
  bindings: CloudflareBindings,
  command: z.infer<typeof cloudflareRemovalCommand>,
  step: CloudflareWorkersModule.WorkflowStep,
  transport = fetch,
) => {
  const runner = createCloudflareRemover(bindings, transport);

  const options = {
    retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
    timeout: "2 minutes",
  } as const;

  try {
    const targets = await step.do("register-removal", options, () =>
      retryable(() => runner.register(command)),
    );

    for (const target of targets) {
      const present = await step.do(`unpublish-${target.id}`, options, () =>
        retryable(() => runner.unpublish(target)),
      );

      if (!present) continue;
      await step.do(`remove-events-${target.id}`, options, () =>
        retryable(() => runner.events(target)),
      );

      for (let page = 0; ; page++) {
        const done = await step.do(`purge-workflows-${target.id}-${page}`, options, () =>
          retryable(() => runner.purgeWorkflows(target, command.id)),
        );

        if (done) break;
      }

      const resources = await step.do(`inventory-${target.id}`, options, () =>
        retryable(() => runner.inventory(target.id)),
      );

      await step.do(`detach-${target.id}`, options, () =>
        retryable(() => runner.detach(resources.map((resource) => resource.name))),
      );

      for (const resource of resources)
        for (let page = 0; ; page++) {
          const done = await step.do(`remove-${resource.name}-${page}`, options, () =>
            retryable(() => runner.resource(resource)),
          );

          if (done) break;
        }

      for (const prefix of [
        `apps/${target.id}/`,
        `versions/${target.id}/`,
        `access/${target.id}/`,
        `workflow-versions/${target.id}/`,
      ])
        for (let page = 0; ; page++) {
          const done = await step.do(`storage-${prefix}-${page}`, options, () =>
            retryable(() => runner.storage(prefix)),
          );

          if (done) break;
        }

      await step.do(`finish-${target.id}`, options, () =>
        retryable(() => runner.finishApp(target.id)),
      );
    }
  } catch (error) {
    await step.do("record-removal-failure", options, () =>
      runner.fail(command.id, "Cloudflare could not complete app removal"),
    );
    throw error;
  }
};
