import { z } from "zod";
import { cloudflareCall, createCloudflareClient } from "./cloudflare-client.ts";
import { readCloudflareAppQueues } from "./cloudflare-events.ts";

const queue = z.object({
  queue_id: z.string(),
  queue_name: z.string(),
  settings: z.object({ delivery_paused: z.boolean() }),
});

// Create one publisher per evaluation. A fresh provider snapshot on the next run
// also repairs failed writes and includes queues registered since the last run.
export const createQueueAvailabilityPublisher = (
  storage: Parameters<typeof readCloudflareAppQueues>[0],
  configuration: { accountId: string; token: string },
  transport: typeof fetch = fetch,
) => {
  const client = createCloudflareClient(configuration.token, transport);
  const account = { account_id: configuration.accountId };

  const read = async () => {
    const apps = await readCloudflareAppQueues(storage);
    const queues = new Map<string, z.infer<typeof queue>>();

    if ([...apps.values()].some((names) => names.length)) {
      // cloudflare 7.3 models this endpoint as SinglePage; page explicitly.
      for (let page = 1; ; page++) {
        const response = await cloudflareCall("list queues", () =>
          client.queues.list(account, { query: { page, per_page: 100 } }),
        );

        for (const entry of response.result) {
          const value = queue.parse(entry);
          queues.set(value.queue_name, value);
        }

        if (response.result.length < 100) break;
      }
    }

    return { apps, queues };
  };

  let snapshot: ReturnType<typeof read> | undefined;

  return async (appIds: readonly string[], blocked: boolean) => {
    const { apps, queues } = await (snapshot ??= read());
    const failures: Error[] = [];

    for (const appId of appIds) {
      for (const name of apps.get(appId) ?? []) {
        try {
          const native = queues.get(name);

          if (!native) throw new Error("The registered app queue is missing");

          if (native.settings.delivery_paused === blocked) continue;

          await cloudflareCall("update queue delivery", () =>
            client.queues.edit(native.queue_id, {
              ...account,
              settings: { delivery_paused: blocked },
            }),
          );
          native.settings.delivery_paused = blocked;
        } catch (cause) {
          failures.push(new Error(`Queue delivery publication failed for ${name}`, { cause }));
        }
      }
    }

    if (failures.length) throw new AggregateError(failures, "Queue delivery publication failed");
  };
};
