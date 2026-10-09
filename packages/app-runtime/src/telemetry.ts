import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

const level = new Map([
  ["debug", 5],
  ["log", 9],
  ["info", 9],
  ["warn", 13],
  ["error", 17],
]);

const structured = z.object({ widefleet: z.literal(1), source: z.enum(["server", "browser"]) });

// Tail props are created by the trusted loader, never by the application.
export class Telemetry extends WorkerEntrypoint<
  {},
  { url: string; token: string; deploymentId: string; buildId: string | null }
> {
  private body(message: string, kind: "log" | "error") {
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
      deploymentId: this.ctx.props.deploymentId,
      buildId: this.ctx.props.buildId,
    });
  }

  override async tail(events: TraceItem[]) {
    const records = events.flatMap((event) => [
      ...event.logs.map((log) => ({
        timeUnixNano: String(BigInt(Math.trunc(log.timestamp)) * 1_000_000n),
        severityNumber: level.get(log.level) ?? 9,
        severityText: log.level.toUpperCase(),
        body: { stringValue: this.body(z.array(z.string()).parse(log.message).join(" "), "log") },
      })),
      ...event.exceptions.map((exception) => ({
        timeUnixNano: String(BigInt(Math.trunc(exception.timestamp)) * 1_000_000n),
        severityNumber: 17,
        severityText: "ERROR",
        body: { stringValue: this.body(exception.message, "error") },
      })),
    ]);

    if (records.length === 0) return;

    const response = await fetch(`${this.ctx.props.url}/v1/logs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.ctx.props.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        resourceLogs: [
          { scopeLogs: [{ scope: { name: "widefleet.runtime" }, logRecords: records }] },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });

    await response.body?.cancel();

    if (!response.ok) throw new Error("Telemetry collector rejected the app logs");
  }
}
