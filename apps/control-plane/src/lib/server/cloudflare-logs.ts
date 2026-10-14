import { cloudflareLog } from "@platform/app-runtime/logs";
import * as contract from "@platform/contracts";
import { z } from "zod";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { TelemetryNotConfigured } from "./errors.ts";

const leaf = (key: string, operation: string, value: string) => ({
  key,
  operation,
  value,
  type: "string",
});

const numeric = (key: string, operation: string, value: number) => ({
  key,
  operation,
  value,
  type: "number",
});

const responseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    events: z.object({
      events: z.array(
        z.object({
          $metadata: z.object({ id: z.string().min(1).max(256) }),
          $workers: z.object({ scriptName: z.string() }),
          source: cloudflareLog,
        }),
      ),
    }),
  }),
});

export const createCloudflareLogs =
  (
    bindings: Pick<
      CloudflareBindings,
      "CLOUDFLARE_ACCOUNT_ID" | "CLOUDFLARE_API_TOKEN" | "APP_RUNTIME_NAME"
    >,
    transport: typeof fetch = fetch,
  ) =>
  async (
    input: z.infer<typeof contract.logQuery>,
    window: {
      since: string;
      until: string;
      through: string;
      offset: string | undefined;
      buildId: string;
    },
  ) => {
    if (
      !bindings.CLOUDFLARE_ACCOUNT_ID ||
      !bindings.CLOUDFLARE_API_TOKEN ||
      !bindings.APP_RUNTIME_NAME
    )
      throw new TelemetryNotConfigured({
        message: "Cloudflare runtime logging is not configured for this installation.",
      });

    const filters = [
      leaf("$workers.scriptName", "eq", bindings.APP_RUNTIME_NAME),
      numeric("widefleetLog", "eq", 1),
      leaf("appId", "eq", input.appId),
      numeric(
        "eventTime",
        "gte",
        Date.parse(window.since) + (/\.(\d{3}\d*[1-9])/.test(window.since) ? 1 : 0),
      ),
      numeric("eventTime", "lte", Date.parse(window.until)),
      numeric("receivedTime", "lt", Number(BigInt(window.through) / 1000n)),
    ];

    if (input.receivedAfter)
      filters.push(
        numeric("receivedTime", "gte", Number((BigInt(input.receivedAfter) + 999n) / 1000n)),
      );

    if (input.level)
      filters.push(
        numeric("severity", "gte", { debug: 5, info: 9, warn: 13, error: 17 }[input.level]),
      );

    for (const key of ["source", "requestId", "traceId"] as const)
      if (input[key]) filters.push(leaf(`record.${key}`, "eq", input[key]));

    if (input.query)
      filters.push(
        leaf("record.body", "regex", `(?i)${input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );

    const deploymentFilter = input.deploymentId
      ? [
          {
            kind: "group",
            filterCombination: "or",
            filters: [
              leaf("record.deploymentId", "eq", input.deploymentId),
              ...(window.buildId
                ? [
                    {
                      kind: "group",
                      filterCombination: "and",
                      filters: [
                        leaf("record.source", "eq", "browser"),
                        leaf("record.buildId", "eq", window.buildId),
                      ],
                    },
                  ]
                : []),
            ],
          },
        ]
      : [];

    const response = await transport(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(bindings.CLOUDFLARE_ACCOUNT_ID)}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bindings.CLOUDFLARE_API_TOKEN}`,
          "content-type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          queryId: "widefleet-runtime-logs",
          view: "events",
          dry: true,
          limit: input.limit + 1,
          offset: window.offset,
          offsetDirection: "next",
          // Cloudflare timestamps the tail's console output. Filter the original
          // event time separately so delayed tails can still appear in --follow.
          timeframe: { from: Date.parse(window.since), to: Number(BigInt(window.through) / 1000n) },
          parameters: {
            datasets: ["cloudflare-workers"],
            filterCombination: "and",
            filters: [...filters, ...deploymentFilter],
          },
        }),
      },
    );

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Cloudflare log query failed (HTTP ${response.status})`);
    }

    const events = responseSchema.parse(await response.json()).result.events.events;

    for (const event of events)
      if (
        event.source.appId !== input.appId ||
        event.$workers.scriptName !== bindings.APP_RUNTIME_NAME
      )
        throw new Error("Cloudflare returned logs outside the authorized app");

    const selected = events.slice(0, input.limit);

    return {
      entries: selected.map((event) =>
        contract.runtimeLog.parse({ ...event.source.record, id: event.$metadata.id, frames: [] }),
      ),
      offset: events.length > input.limit ? selected.at(-1)?.$metadata.id : undefined,
    };
  };
