import type { TelemetryQueryParams } from "cloudflare/resources/workers/observability/telemetry";
import { cloudflareLog } from "@platform/app-runtime/logs";
import * as contract from "@platform/contracts";
import { z } from "zod";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { cloudflareCall, createCloudflareClient } from "./cloudflare-client.ts";
import { TelemetryNotConfigured } from "./errors.ts";
import type { runtimeLogQuery } from "./telemetry.ts";

const leaf = (key: string, operation: "eq" | "regex", value: string) => ({
  key,
  operation,
  value,
  type: "string" as const,
});

const numeric = (key: string, operation: "eq" | "gte" | "lte" | "lt", value: number) => ({
  key,
  operation,
  value,
  type: "number" as const,
});

// Workers Logs omits null-valued fields in query responses. Restore them at this boundary.
const queriedLog = cloudflareLog.extend({
  appId: cloudflareLog.shape.appId.default(null),
  record: cloudflareLog.shape.record.extend({
    stack: contract.runtimeLog.shape.stack.default(null),
    buildId: contract.runtimeLog.shape.buildId.default(null),
    deploymentId: contract.runtimeLog.shape.deploymentId.default(null),
    requestId: contract.runtimeLog.shape.requestId.default(null),
    traceId: contract.runtimeLog.shape.traceId.default(null),
    spanId: contract.runtimeLog.shape.spanId.default(null),
    route: contract.runtimeLog.shape.route.default(null),
    status: contract.runtimeLog.shape.status.default(null),
  }),
});

const responseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    events: z.object({
      events: z.array(
        z.object({
          $metadata: z.object({ id: z.string().min(1).max(256) }),
          $workers: z.object({ scriptName: z.string() }),
          source: queriedLog,
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
    input: z.infer<typeof runtimeLogQuery>,
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
      ...("appId" in input
        ? [leaf("appId", "eq", input.appId)]
        : [
            leaf("organizationId", "eq", input.organizationId),
            leaf("connector", "eq", input.name),
            ...(input.version ? [leaf("record.connectorVersion", "eq", input.version)] : []),
          ]),
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

    const deploymentFilter =
      "appId" in input && input.deploymentId
        ? [
            {
              kind: "group" as const,
              filterCombination: "or" as const,
              filters: [
                leaf("record.deploymentId", "eq", input.deploymentId),
                ...(window.buildId
                  ? [
                      {
                        kind: "group" as const,
                        filterCombination: "and" as const,
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

    const accountId = bindings.CLOUDFLARE_ACCOUNT_ID;
    const client = createCloudflareClient(bindings.CLOUDFLARE_API_TOKEN, transport);

    const query: TelemetryQueryParams = {
      account_id: accountId,
      queryId: "widefleet-runtime-logs",
      view: "events",
      dry: true,
      limit: input.limit + 1,
      offsetDirection: "next",
      // Cloudflare timestamps the tail's console output. Filter the original
      // event time separately so delayed tails can still appear in --follow.
      timeframe: { from: Date.parse(window.since), to: Number(BigInt(window.through) / 1000n) },
      parameters: {
        datasets: ["cloudflare-workers"],
        filterCombination: "and" as const,
        filters: [...filters, ...deploymentFilter],
      },
    };

    if (window.offset !== undefined) query.offset = window.offset;

    const response = await cloudflareCall("query runtime logs", () =>
      client.workers.observability.telemetry.query(query, { timeout: 20_000 }),
    );

    const events = responseSchema.shape.result.parse(response).events.events;

    for (const event of events)
      if (
        ("appId" in input
          ? event.source.appId !== input.appId
          : event.source.appId !== null ||
            event.source.organizationId !== input.organizationId ||
            event.source.connector !== input.name) ||
        event.$workers.scriptName !== bindings.APP_RUNTIME_NAME
      )
        throw new Error("Cloudflare returned logs outside the authorized source");

    const selected = events.slice(0, input.limit);

    return {
      entries: selected.map((event) =>
        contract.runtimeLog.parse({ ...event.source.record, id: event.$metadata.id, frames: [] }),
      ),
      offset: events.length > input.limit ? selected.at(-1)?.$metadata.id : undefined,
    };
  };
