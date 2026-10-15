import * as contract from "@platform/contracts";
import { z } from "zod";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { Database } from "./database.ts";
import {
  cloudflareResourceName,
  type createCloudflareProvisioner,
} from "./cloudflare-provisioning.ts";
import {
  updateCloudflareSubscription,
  cloudflareSubscriptionRejected,
} from "./cloudflare-subscription-updates.ts";
import { InvalidOperation } from "./errors.ts";

const events = z.object({
  crons: z.array(z.string()),
  queue_consumers: z.array(contract.queueConsumer),
});

const registration = z.object({
  hostname: z.string(),
  deleted: z.boolean().default(false),
  sequence: z.number(),
  published: events.nullable(),
  pending: z.record(
    z.string(),
    z.object({ sequence: z.number(), events, activating: z.boolean() }),
  ),
  queues: z.array(z.string()),
});

const registry = z.object({
  apps: z.record(z.string(), registration),
  configuration: contract.appEventConfiguration,
});

const key = "events/configuration.json";

const consumerSettings = z.object({
  script_name: z.string(),
  type: z.literal("worker"),
  dead_letter_queue: z.string().default(""),
  settings: z
    .object({
      batch_size: z.number().default(10),
      max_wait_time_ms: z.number().default(5000),
      max_retries: z.number().default(3),
      retry_delay: z.number().default(0),
    })
    .prefault({}),
});

const consumer = consumerSettings.nullable();

const configuration = (apps: z.infer<typeof registry>["apps"]) => {
  const crons: Record<string, string[]> = {};
  const queues: Record<string, { hostname: string; queue: string }> = {};

  for (const [appId, app] of Object.entries(apps)) {
    if (app.deleted) continue;

    const versions = [
      ...Object.values(app.pending).map((entry) => entry.events),
      ...(app.published ? [app.published] : []),
    ];

    for (const version of versions) {
      for (const cron of version.crons) {
        const hosts = crons[cron] ?? [];

        if (!hosts.includes(app.hostname)) hosts.push(app.hostname);
        crons[cron] = hosts.sort();
      }

      for (const entry of version.queue_consumers)
        queues[cloudflareResourceName(appId, "queue", entry.queue)] = {
          hostname: app.hostname,
          queue: entry.queue,
        };
    }
  }

  return { crons, queues };
};

export const createCloudflareEvents = (
  storage: R2Bucket,
  database: Database,
  provisioner: ReturnType<typeof createCloudflareProvisioner>,
  runtimeName: string,
) => {
  const read = async () => {
    const object = await storage.get(key);

    return {
      object,
      value: object
        ? registry.parse(await object.json())
        : { apps: {}, configuration: { crons: {}, queues: {} } },
    };
  };

  const change = async (update: (apps: z.infer<typeof registry>["apps"]) => void) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { object, value } = await read();
      update(value.apps);
      const body = JSON.stringify({ apps: value.apps, configuration: configuration(value.apps) });

      const written = await storage.put(key, body, {
        onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      });

      if (written) return;
    }

    throw new Error("Event registration changed concurrently; retry the deployment");
  };

  const script = `/workers/scripts/${encodeURIComponent(runtimeName)}/schedules`;

  const syncCrons = () =>
    updateCloudflareSubscription(
      database,
      `${provisioner.scope}/schedules`,
      z.array(z.string()),
      async () =>
        z
          .object({ schedules: z.array(z.object({ cron: z.string() })) })
          .parse(await provisioner.request(script))
          .schedules.map((item) => item.cron)
          .sort(),
      async () => Object.keys((await read()).value.configuration.crons).sort(),
      async (crons) => {
        await provisioner.request(script, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(crons.map((cron) => ({ cron }))),
        });
      },
    );

  const syncQueues = async (selectedAppId: string) => {
    const snapshot = await read();

    for (const [appId, app] of Object.entries(snapshot.value.apps)) {
      if (appId !== selectedAppId) continue;

      for (const name of app.queues) {
        const nativeName = cloudflareResourceName(appId, "queue", name);

        // Deployment provisioning creates queues before activation. Subscription
        // reconciliation must never recreate a resource from an old registry snapshot.
        const native = await provisioner.findQueue(nativeName);

        if (!native) {
          if (app.deleted) continue;
          throw new Error("The provisioned app queue is missing");
        }

        const path = `/queues/${encodeURIComponent(native.queue_id)}/consumers`;
        let consumerId: string | null = null;
        await updateCloudflareSubscription(
          database,
          `${provisioner.scope}/queues/${native.queue_id}`,
          consumer,
          async () => {
            const response = z
              .object({
                consumers: z
                  .array(
                    z
                      .object({
                        consumer_id: z.string(),
                        type: z.string(),
                        script_name: z.string().optional(),
                        script: z.string().optional(),
                        service: z.string().optional(),
                        environment: z.string().optional(),
                      })
                      .passthrough(),
                  )
                  .default([]),
              })
              .parse(await provisioner.request(`/queues/${encodeURIComponent(native.queue_id)}`));

            if (
              response.consumers.length > 1 ||
              response.consumers.some(
                (item) =>
                  item.type !== "worker" ||
                  (item.script_name ?? item.script ?? item.service) !== runtimeName ||
                  (item.environment !== undefined && item.environment !== "production"),
              )
            )
              throw new InvalidOperation({
                code: "CONFLICT",
                message: "The app queue has an unexpected consumer",
              });
            const existing = response.consumers[0];
            consumerId = existing?.consumer_id ?? null;

            // Queue responses also use the script/service fields consumed by Wrangler.
            return existing
              ? consumerSettings.parse({
                  ...existing,
                  script_name: existing.script_name ?? existing.script ?? existing.service,
                })
              : null;
          },
          async () => {
            const current = (await read()).value.apps[appId];

            const selected = current?.published?.queue_consumers.find(
              (entry) => entry.queue === name,
            );

            if (!selected) return null;

            return consumerSettings.parse({
              script_name: runtimeName,
              type: "worker",
              dead_letter_queue: selected.dead_letter_queue
                ? cloudflareResourceName(appId, "queue", selected.dead_letter_queue)
                : "",
              settings: {
                batch_size: selected.max_batch_size,
                max_wait_time_ms:
                  selected.max_batch_timeout === undefined
                    ? undefined
                    : selected.max_batch_timeout * 1000,
                max_retries: selected.max_retries,
                retry_delay: selected.retry_delay,
              },
            });
          },
          async (target) => {
            if (!target) {
              if (!consumerId) throw new Error("Queue consumer disappeared during removal");
              await provisioner.request(`${path}/${encodeURIComponent(consumerId)}`, {
                method: "DELETE",
              });
            } else {
              await provisioner.request(
                consumerId ? `${path}/${encodeURIComponent(consumerId)}` : path,
                {
                  method: consumerId ? "PUT" : "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(target),
                },
              );
            }
          },
        );
      }
    }
  };

  return {
    async remove(appId: string, hostname: string) {
      await change((apps) => {
        const current = apps[appId];
        apps[appId] = {
          hostname,
          sequence: current?.sequence ?? 0,
          deleted: true,
          published: null,
          pending: {},
          queues: current?.queues ?? [],
        };
      });
      await syncCrons();
      await syncQueues(appId);
    },
    registered: async (appId: string) => (await read()).value.apps[appId] !== undefined,
    async stage(id: string, app: z.infer<typeof contract.publishedApp>, sequence: number) {
      await change((apps) => {
        const current = apps[app.appId] ?? {
          deleted: false,
          hostname: app.hostname,
          sequence: 0,
          published: null,
          pending: {},
          queues: [],
        };

        if (current.deleted)
          throw new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" });

        if (sequence < current.sequence) return;
        const staged = events.parse(app.metadata);
        apps[app.appId] = {
          ...current,
          pending: {
            ...current.pending,
            [id]: {
              sequence,
              events: staged,
              activating: current.pending[id]?.activating ?? false,
            },
          },
          queues: [
            ...new Set([...current.queues, ...staged.queue_consumers.map((entry) => entry.queue)]),
          ].sort(),
        };
      });

      try {
        await syncCrons();
      } catch (error) {
        if (error instanceof Error && cloudflareSubscriptionRejected(error))
          await change((apps) => {
            const current = apps[app.appId];

            // Only discard stages that have never attempted the host switch.
            // An earlier attempt may have activated despite losing its response.
            if (current?.pending[id] && !current.pending[id].activating) delete current.pending[id];
          });
        throw error;
      }
    },
    async beginActivation(id: string, appId: string) {
      await change((apps) => {
        if (apps[appId]?.deleted)
          throw new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" });
        const staged = apps[appId]?.pending[id];

        if (!staged) throw new Error("App event registration is not staged");
        staged.activating = true;
      });
    },
    async publish(app: z.infer<typeof contract.publishedApp>, sequence: number) {
      await change((apps) => {
        const current = apps[app.appId];

        if (!current) throw new Error("App events have not been staged");

        if (current.deleted)
          throw new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" });

        // A failed activation can still have reached R2 after losing its response.
        // Retain staged routes until a confirmed newer activation fences it out.
        for (const [pendingId, entry] of Object.entries(current.pending))
          if (entry.sequence <= sequence) delete current.pending[pendingId];

        if (sequence >= current.sequence) {
          current.sequence = sequence;
          current.published = events.parse(app.metadata);
        }
      });
      await syncCrons();
      await syncQueues(app.appId);
    },
  };
};
