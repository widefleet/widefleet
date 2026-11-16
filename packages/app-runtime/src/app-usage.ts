import {
  reportingWeek,
  runtimeReportingCredentials,
  runtimeReportingStatus,
} from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";

const configuration = runtimeReportingCredentials.extend({ url: z.url() });

const week = 7 * 24 * 60 * 60 * 1000;

export const createRuntimeUsage = (
  settings: z.infer<typeof configuration>,
  transport: typeof fetch = fetch,
) => {
  let source = crypto.randomUUID();
  let revision = settings.revision;
  let enabled = settings.enabled;
  let scheduled = false;
  let inflight = 0;
  let observedWeek = "";

  const counts = new Map<
    string,
    { appId: string; weekStart: string; invocations: number; sent: number }
  >();

  const flush = async () => {
    scheduled = false;

    if (inflight >= 2) return;
    inflight++;
    const generation = { source, revision };

    const pending = [...counts.values()].flatMap(({ appId, weekStart, invocations, sent }) =>
      invocations > sent ? [{ appId, weekStart, invocations }] : [],
    );

    try {
      // An empty batch refreshes preferences when counting is disabled.
      for (let offset = 0; offset < Math.max(1, pending.length); offset += 100) {
        const batch = pending.slice(offset, offset + 100);

        const response = await transport(settings.url, {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${settings.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...generation, counts: batch }),
          signal: AbortSignal.timeout(2000),
        });

        if (!response.ok) {
          await response.body?.cancel();

          return;
        }

        const current = runtimeReportingStatus.parse(await response.json());

        if (source !== generation.source) return;

        if (current.revision !== revision || current.enabled !== enabled) {
          // Never replay buffered usage across an opt-out/preference change.
          counts.clear();
          source = crypto.randomUUID();
          revision = current.revision;
          enabled = current.enabled;

          return;
        }

        for (const item of batch) {
          const entry = counts.get(`${item.weekStart}:${item.appId}`);

          if (entry) entry.sent = Math.max(entry.sent, item.invocations);
        }
      }
    } catch {
      // Best-effort reporting must not affect app execution. A later invocation
      // resends cumulative counters; the installation merges them with MAX.
    } finally {
      inflight--;
    }
  };

  return (appId: string, context: Pick<ExecutionContext, "waitUntil">) => {
    const weekStart = reportingWeek();

    if (weekStart !== observedWeek) {
      const oldest = reportingWeek(Date.now() - week);

      for (const [key, value] of counts) if (value.weekStart < oldest) counts.delete(key);
      observedWeek = weekStart;
    }

    if (enabled) {
      const key = `${weekStart}:${appId}`;
      const entry = counts.get(key);

      if (entry) entry.invocations++;
      else counts.set(key, { appId, weekStart, invocations: 1, sent: 0 });
    }

    if (scheduled) return;
    scheduled = true;
    context.waitUntil(new Promise<void>((resolve) => setTimeout(resolve, 5000)).then(flush));
  };
};

let configured: string | undefined;

let record: ReturnType<typeof createRuntimeUsage> | undefined;

export const recordAppInvocation = (
  environment: ParentEnvironment,
  context: ExecutionContext,
  appId: string,
) => {
  const value = environment.WIDEFLEET_USAGE_REPORTING;

  if (!value) return;

  try {
    if (value !== configured) {
      record = createRuntimeUsage(configuration.parse(JSON.parse(value)));
      configured = value;
    }

    record?.(appId, context);
  } catch {
    /* Reporting configuration cannot break an app invocation. */
  }
};
