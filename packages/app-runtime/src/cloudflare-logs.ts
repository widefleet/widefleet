import { organizationIdentifier } from "@platform/contracts";
import type { TraceItem } from "@cloudflare/workers-types";
import { runtimeLog } from "@platform/contracts";
import { z } from "zod";

export const cloudflareLog = z.object({
  widefleetLog: z.literal(1),
  appId: z.uuid().nullable(),
  organizationId: organizationIdentifier.nullable().default(null),
  eventTime: z.number(),
  receivedTime: z.number(),
  severity: z.number(),
  record: runtimeLog.omit({ id: true, frames: true }),
});

const report = z.object({
  widefleet: z.literal(1),
  source: z.enum(["server", "browser"]),
  kind: z.enum(["log", "request", "error"]).catch("log"),
  message: z.string().catch(""),
  stack: z.string().nullable().catch(null),
  buildId: z.string().max(128).nullable().catch(null),
  requestId: z.string().max(128).nullable().catch(null),
  traceId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable()
    .catch(null),
  spanId: z.string().max(128).nullable().catch(null),
  route: z.string().max(2048).nullable().catch(null),
  status: z.number().int().nullable().catch(null),
});

const parseReport = (message: string) => {
  try {
    return report.safeParse(JSON.parse(message)).data;
  } catch {
    return undefined;
  }
};

const consoleText = (message: z.infer<ReturnType<typeof z.json>>[]) =>
  message.map((part) => z.string().safeParse(part).data ?? JSON.stringify(part)).join(" ");

export const cloudflareLogRecords = (
  event: Pick<TraceItem, "logs" | "exceptions" | "eventTimestamp" | "outcome" | "truncated">,
  props: {
    appId: string;
    organizationId?: string | undefined;
    deploymentId: string;
    buildId: string | null;
  },
  receivedTime = Date.now(),
) => {
  const logs = event.logs.map((log) => {
    const message = consoleText(z.array(z.json()).parse(log.message));

    return { log, message, parsed: parseReport(message) };
  });

  const request = logs.find((log) => log.parsed?.kind === "request")?.parsed;
  const requestId = request?.requestId ?? crypto.randomUUID();

  const make = (
    message: string,
    timestamp: number,
    level: z.infer<typeof runtimeLog>["level"],
    parsed?: z.infer<typeof report>,
    failure?: { stack?: string },
  ) => {
    const browser = parsed?.source === "browser";

    const output = cloudflareLog.parse({
      widefleetLog: 1,
      appId: props.appId,
      organizationId: props.organizationId ?? null,
      eventTime: timestamp,
      receivedTime,
      severity: { debug: 5, info: 9, warn: 13, error: 17 }[level],
      record: {
        timestamp: new Date(timestamp).toISOString(),
        receivedAt: String(BigInt(receivedTime) * 1000n),
        level,
        source: failure ? "runtime" : (parsed?.source ?? "server"),
        kind: failure ? "span_error" : (parsed?.kind ?? "log"),
        message: parsed?.message ?? message,
        stack: failure?.stack ?? parsed?.stack ?? (/\n\s*at\s/.test(message) ? message : null),
        // Only the loader may attribute a server record to a deployed version.
        // Browser reports retain their build; an open tab may run an older one.
        buildId: browser ? parsed.buildId : props.buildId,
        deploymentId: !browser ? props.deploymentId : null,
        requestId: parsed?.requestId ?? requestId,
        traceId: parsed?.traceId ?? request?.traceId ?? null,
        spanId: parsed?.spanId ?? request?.spanId ?? null,
        route: parsed?.route ?? request?.route ?? null,
        status: parsed?.status ?? null,
        body: message,
      },
    });

    // Re-emitting body, message and stack can exceed Workers Logs' 256 KiB
    // record limit even when the original tail fits. Preserve a valid envelope.
    while (new TextEncoder().encode(JSON.stringify(output)).byteLength > 240 * 1024) {
      for (const key of ["body", "message", "stack"] as const) {
        const text = output.record[key];

        if (text && text.length > 128)
          output.record[key] = `${text.slice(0, Math.floor(text.length / 2))} [truncated]`;
      }
    }

    return output;
  };

  const records = logs.map(({ log, message, parsed }) =>
    make(
      message,
      log.timestamp,
      log.level === "error"
        ? "error"
        : log.level === "warn"
          ? "warn"
          : log.level === "debug"
            ? "debug"
            : "info",
      parsed,
    ),
  );

  for (const exception of event.exceptions)
    records.push(
      make(
        `${exception.name}: ${exception.message}`,
        exception.timestamp,
        "error",
        undefined,
        exception,
      ),
    );

  if (event.outcome !== "ok" && event.exceptions.length === 0)
    records.push(
      make(
        `Worker execution failed: ${event.outcome}`,
        event.eventTimestamp ?? receivedTime,
        "error",
        undefined,
        {},
      ),
    );

  if (event.truncated)
    records.push(make("Cloudflare truncated this invocation's logs", receivedTime, "warn"));

  return records;
};
