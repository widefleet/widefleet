import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { cloudflareLogRecords } from "./cloudflare-logs.ts";

const level = new Map([
  ["debug", 5],
  ["log", 9],
  ["info", 9],
  ["warn", 13],
  ["error", 17],
]);

const structured = z.object({ widefleet: z.literal(1), source: z.enum(["server", "browser"]) });

const sendTelemetry = async (
  destination: { url: string; token: string },
  records: {
    timeUnixNano: string;
    severityNumber: number;
    severityText: string;
    body: { stringValue: string };
  }[],
) => {
  if (records.length === 0) return;

  const response = await fetch(`${destination.url}/v1/logs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${destination.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      resourceLogs: [
        { scopeLogs: [{ scope: { name: "widefleet.runtime" }, logRecords: records }] },
      ],
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });

  await response.body?.cancel();

  if (!response.ok) throw new Error("Telemetry collector rejected the runtime logs");
};

// Tail props are created by the trusted loader, never by the application.
export class Telemetry extends WorkerEntrypoint<
  {},
  { url: string; token: string } & (
    | { deploymentId: string; buildId: string | null }
    | { fleetId: string; connector: string; connectorVersion: string }
  )
> {
  private body(
    message: string,
    kind: "log" | "error",
    identity: { deploymentId: string; buildId: string | null },
  ) {
    try {
      // Structured reports already carry their context. A browser may still be
      // running an older build, so never replace its version with the current one.
      if (structured.safeParse(JSON.parse(message)).success) return message;
    } catch {
      // Ordinary console text is not necessarily JSON; enrich it below.
    }

    return JSON.stringify({
      widefleet: 1,
      source: "server",
      kind,
      message,
      ...identity,
    });
  }

  override async tail(events: TraceItem[]) {
    const props = this.ctx.props;

    if ("connector" in props) {
      const records = events.flatMap((event) => cloudflareLogRecords(event, props));

      await sendTelemetry(
        props,
        records.map(({ eventTime, severity, record }) => ({
          timeUnixNano: String(BigInt(Math.trunc(eventTime)) * 1_000_000n),
          severityNumber: severity,
          severityText: record.level.toUpperCase(),
          traceId: record.traceId ?? undefined,
          spanId: z
            .string()
            .regex(/^[a-f0-9]{16}$/)
            .safeParse(record.spanId).data,
          body: {
            stringValue: JSON.stringify({
              ...record,
              widefleet: 1,
              source: "server",
              kind: record.kind === "span_error" ? "error" : record.kind,
            }),
          },
        })),
      );

      return;
    }

    const identity = { deploymentId: props.deploymentId, buildId: props.buildId };

    const records = events.flatMap((event) => [
      ...event.logs.map((log) => ({
        timeUnixNano: String(BigInt(Math.trunc(log.timestamp)) * 1_000_000n),
        severityNumber: level.get(log.level) ?? 9,
        severityText: log.level.toUpperCase(),
        body: {
          stringValue: this.body(z.array(z.string()).parse(log.message).join(" "), "log", identity),
        },
      })),
      ...event.exceptions.map((exception) => ({
        timeUnixNano: String(BigInt(Math.trunc(exception.timestamp)) * 1_000_000n),
        severityNumber: 17,
        severityText: "ERROR",
        body: { stringValue: this.body(exception.message, "error", identity) },
      })),
    ]);

    await sendTelemetry(this.ctx.props, records);
  }
}
