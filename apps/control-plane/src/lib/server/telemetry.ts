import { createHmac, timingSafeEqual } from "node:crypto";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { appVisibility } from "./apps.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import { InvalidOperation, TelemetryNotConfigured, TelemetryUnavailable } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, artifacts, deployments } from "./schema.ts";
import { createSymbolicator } from "./source-maps.ts";
import type { ArtifactStorage } from "./storage.ts";
import { readBody } from "./upload-body.ts";

const position = z.strictObject({ received: z.string().regex(/^[0-9]+$/), id: z.uuid() });

const cursorData = z.strictObject({
  filter: z.string(),
  since: contract.logTimestamp,
  until: contract.logTimestamp,
  through: z.string().regex(/^[0-9]+$/),
  position,
});

const storedLog = z.object({
  id: z.uuid(),
  timestamp: z.string(),
  receivedAt: z.string(),
  severity: z.number(),
  source: contract.logSource,
  kind: contract.runtimeLog.shape.kind,
  message: z.string(),
  stack: z.string(),
  buildId: z.string(),
  deploymentId: z.string(),
  requestId: z.string(),
  traceId: z.string(),
  spanId: z.string(),
  route: z.string(),
  status: z.number(),
  body: z.string(),
});

const badRequest = (message: string) => new InvalidOperation({ code: "BAD_REQUEST", message });

const nullable = (value: string) => value || null;

const maxRange = 30 * 86_400_000;

const maxRangeNanos = BigInt(maxRange) * 1_000_000n;

// Date handles calendar/offset conversion; preserve the remaining fractional
// digits separately so validation has ClickHouse's nanosecond precision.
const timeNanos = (value: string) => {
  const fraction = (/\.(\d+)/.exec(value)?.[1] ?? "").padEnd(9, "0");

  return BigInt(Date.parse(value)) * 1_000_000n + BigInt(fraction.slice(3));
};

const sinceTime = (value: string, until: string) => {
  const relative = /^([0-9]+)([smhd])$/.exec(value);

  if (!relative) return value;

  const scale = new Map([
    ["s", 1000],
    ["m", 60_000],
    ["h", 3_600_000],
    ["d", 86_400_000],
  ]);

  const duration = Number(relative[1]) * (scale.get(relative[2] ?? "") ?? 0);

  if (duration > maxRange) throw badRequest("Query at most 30 days of logs");

  // Relative durations are whole seconds, so their subtraction retains the
  // upper boundary's exact fraction while converting its timezone to UTC.
  const fraction = /\.\d+/.exec(until)?.[0] ?? ".000";

  return new Date(Date.parse(until) - duration).toISOString().replace(/\.\d+Z$/, `${fraction}Z`);
};

export const createTelemetry = (
  database: Database,
  storage: ArtifactStorage,
  configuration: Configuration,
) => {
  const signature = (value: string) =>
    createHmac("sha256", z.string().min(32).parse(configuration.BETTER_AUTH_SECRET))
      .update(`widefleet-telemetry-v1:${value}`)
      .digest("hex");

  const credentials = (appId: string) =>
    configuration.CLICKHOUSE_URL ? { token: `telemetry_${signature(`ingest:${appId}`)}` } : null;

  let inflight = 0;

  const clickhouse = async (statement: string, parameters = new Map<string, string>()) => {
    if (!configuration.CLICKHOUSE_URL)
      throw new TelemetryNotConfigured({
        message:
          "Runtime logging is not enabled for this installation. An administrator must enable telemetry.",
      });

    const url = new URL(configuration.CLICKHOUSE_URL);

    for (const [key, value] of parameters)
      url.searchParams.set(
        `param_${key}`,
        value
          .replaceAll("\\", "\\\\")
          .replaceAll("\n", "\\n")
          .replaceAll("\r", "\\r")
          .replaceAll("\t", "\\t"),
      );

    const response = await fetch(url, {
      method: "POST",
      body: `${statement} FORMAT JSON`,
      redirect: "error",
      headers: {
        "x-clickhouse-user": configuration.CLICKHOUSE_USER,
        "x-clickhouse-key": configuration.CLICKHOUSE_PASSWORD,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ClickHouse query failed (${response.status})`);
    }

    return z.json().parse(await response.json());
  };

  const ingest = async (request: Request, appId: string, signal: "logs" | "traces") => {
    const expected = credentials(appId)?.token;
    const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

    if (
      !expected ||
      !/^telemetry_[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      return new Response("Invalid telemetry credentials", { status: 401 });

    if (inflight >= 8)
      return new Response("Telemetry ingress is busy", {
        status: 429,
        headers: { "retry-after": "5" },
      });
    inflight++;

    try {
      const [app] = await database
        .select({ id: apps.id })
        .from(apps)
        .where(and(eq(apps.id, appId), ne(apps.state, "deleting")))
        .limit(1);

      if (!app) return new Response("Telemetry source is unavailable", { status: 403 });

      const contentType = request.headers.get("content-type")?.split(";", 1)[0];

      if (
        !contentType ||
        !["application/x-protobuf", "application/json"].includes(contentType) ||
        request.headers.has("content-encoding")
      )
        return new Response("Expected uncompressed OTLP protobuf or JSON", { status: 415 });

      const bytes = await readBody(request, 16 * 1024 * 1024);

      if (bytes.isErr()) return new Response("Telemetry batch exceeds the limit", { status: 413 });

      const response = await fetch(
        `${configuration.OTEL_COLLECTOR_URL.replace(/\/$/, "")}/v1/${signal}`,
        {
          method: "POST",
          body: Buffer.from(bytes.value),
          redirect: "error",
          headers: { "content-type": contentType, "x-widefleet-app-id": appId },
          signal: AbortSignal.timeout(8000),
        },
      );

      if (!response.ok) {
        await response.body?.cancel();

        return new Response("Collector did not accept the batch", {
          status: response.status === 400 ? 400 : 503,
        });
      }

      return new Response(await response.arrayBuffer(), {
        headers: { "content-type": contentType, "cache-control": "no-store" },
      });
    } catch (cause) {
      console.error("Telemetry ingress failed", cause);

      return new Response("Telemetry ingress is unavailable", { status: 503 });
    } finally {
      inflight--;
    }
  };

  const query = (principal: Principal, input: z.infer<typeof contract.logQuery>) =>
    Result.tryPromise({
      try: async () => {
        const [app] = await database
          .select({ id: apps.id })
          .from(apps)
          .where(and(eq(apps.id, input.appId), appVisibility(database, principal)))
          .limit(1);

        if (!app) throw new InvalidOperation({ code: "NOT_FOUND", message: "App not found" });

        const { cursor, ...filters } = input;
        const filter = signature(JSON.stringify(filters));
        let saved: z.infer<typeof cursorData> | undefined;

        if (cursor) {
          const [data, mac] = cursor.split(".");

          if (!data || mac !== signature(`cursor:${data}`)) throw badRequest("Invalid log cursor");
          saved = cursorData.parse(JSON.parse(Buffer.from(data, "base64url").toString("utf8")));

          if (saved.filter !== filter) throw badRequest("Log cursor does not match these filters");
        }

        const until = saved?.until ?? input.until ?? new Date().toISOString();
        const end = timeNanos(until);
        let since = saved?.since ?? sinceTime(input.since, until);

        // Each follow window stays bounded as time advances; a paginated window
        // keeps both event-time boundaries from its signed cursor unchanged.
        if (
          !saved &&
          input.receivedAfter !== undefined &&
          input.until === undefined &&
          end - timeNanos(since) > maxRangeNanos
        )
          since = sinceTime("30d", until);

        if (end <= timeNanos(since) || end - timeNanos(since) > maxRangeNanos)
          throw badRequest("Use an increasing time range of at most 30 days");

        const through =
          saved?.through ??
          z
            .object({ data: z.array(z.object({ watermark: z.string() })).length(1) })
            .parse(
              await clickhouse("SELECT toString(toUnixTimestamp64Micro(now64(6))) AS watermark"),
            ).data[0]?.watermark;

        if (!through) throw new Error("Missing ClickHouse watermark");

        const parameters = new Map([
          ["app", input.appId],
          ["since", since],
          ["until", until],
          ["through", through],
          ["limit", String(input.limit + 1)],
        ]);

        const conditions = [
          "l.ServiceName = {app:String}",
          "l.Timestamp >= parseDateTime64BestEffort({since:String}, 9)",
          "l.Timestamp <= parseDateTime64BestEffort({until:String}, 9)",
          "l.ReceivedAt < fromUnixTimestamp64Micro({through:Int64})",
        ];

        if (input.receivedAfter) {
          parameters.set("after", input.receivedAfter);
          conditions.push("l.ReceivedAt >= fromUnixTimestamp64Micro({after:Int64})");
        }

        const ascending = input.receivedAfter !== undefined;

        if (saved) {
          parameters.set("position", saved.position.received);
          parameters.set("id", saved.position.id);
          conditions.push(
            `(l.ReceivedAt, l.Id) ${ascending ? ">" : "<"} (fromUnixTimestamp64Micro({position:Int64}), {id:String})`,
          );
        }

        if (input.level) {
          parameters.set("level", String({ debug: 5, info: 9, warn: 13, error: 17 }[input.level]));
          conditions.push("l.SeverityNumber >= {level:UInt8}");
        }

        if (input.source) {
          parameters.set("source", input.source);
          conditions.push("l.Source = {source:String}");
        }

        if (input.traceId) {
          parameters.set("trace", input.traceId);
          conditions.push("l.TraceId = {trace:String}");
        }

        if (input.deploymentId) {
          const [deployment] = await database
            .select({ metadata: artifacts.metadata })
            .from(deployments)
            .innerJoin(artifacts, eq(deployments.artifactId, artifacts.id))
            .where(and(eq(deployments.appId, input.appId), eq(deployments.id, input.deploymentId)))
            .limit(1);

          if (!deployment)
            throw new InvalidOperation({ code: "NOT_FOUND", message: "Deployment not found" });
          const build = contract.workerMetadata.parse(deployment.metadata).debug?.build_id ?? "";
          parameters.set("deployment", input.deploymentId);
          parameters.set("deploymentBuild", build);
          conditions.push(
            "(deploymentId = {deployment:String} OR (l.Source = 'browser' AND {deploymentBuild:String} != '' AND l.BuildId = {deploymentBuild:String}))",
          );
        }

        if (input.requestId) {
          parameters.set("request", input.requestId);
          conditions.push("requestId = {request:String}");
        }

        if (input.query) {
          parameters.set("query", input.query);
          conditions.push("positionCaseInsensitiveUTF8(l.Body, {query:String}) > 0");
        }

        // Console records and native failures inherit the structured request's
        // version/context, scoped to this app and span (never a cross-app trace join).
        const statement = `SELECT l.Id AS id,
        formatDateTime(l.Timestamp, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS timestamp,
        toString(toUnixTimestamp64Micro(l.ReceivedAt)) AS receivedAt,
        l.SeverityNumber AS severity, l.Source AS source, l.Kind AS kind,
        l.Message AS message, l.Stack AS stack,
        if(l.Source = 'browser' OR l.BuildId != '', l.BuildId, c.build) AS buildId,
        if(l.Source = 'browser' OR l.DeploymentId != '', l.DeploymentId, c.deployment) AS deploymentId,
        if(l.RequestId != '', l.RequestId, c.request) AS requestId,
        l.TraceId AS traceId, l.SpanId AS spanId,
        if(l.Route != '', l.Route, c.route) AS route, l.Status AS status, l.Body AS body
        FROM widefleet.runtime_logs l
        LEFT JOIN (
          SELECT TraceId, SpanId, anyIf(BuildId, BuildId != '') AS build,
            anyIf(DeploymentId, DeploymentId != '') AS deployment,
            anyIf(RequestId, RequestId != '') AS request, anyIf(Route, Route != '') AS route
          FROM widefleet.runtime_logs
          WHERE ServiceName = {app:String} AND TraceId != '' AND Source = 'server'
            AND Timestamp >= parseDateTime64BestEffort({since:String}, 9)
            AND Timestamp <= parseDateTime64BestEffort({until:String}, 9)
          GROUP BY TraceId, SpanId
        ) c ON l.TraceId = c.TraceId AND l.SpanId = c.SpanId
        WHERE ${conditions.join(" AND ")}
        ORDER BY l.ReceivedAt ${ascending ? "ASC" : "DESC"}, l.Id ${ascending ? "ASC" : "DESC"}
        LIMIT {limit:UInt32}`;

        const rows = z
          .object({ data: z.array(storedLog) })
          .parse(await clickhouse(statement, parameters)).data;

        const more = rows.length > input.limit;
        const selected = rows.slice(0, input.limit);
        const symbolicate = createSymbolicator(database, storage, input.appId);
        const entries: z.infer<typeof contract.runtimeLog>[] = [];

        for (const row of selected) {
          const { severity, ...fields } = row;

          const level =
            severity >= 17 ? "error" : severity >= 13 ? "warn" : severity >= 9 ? "info" : "debug";

          entries.push(
            await symbolicate({
              ...fields,
              level,
              frames: [],
              stack: nullable(row.stack) ?? (/\n\s*at\s/.test(row.message) ? row.message : null),
              buildId: nullable(row.buildId),
              deploymentId: contract.identifier.safeParse(row.deploymentId).data ?? null,
              requestId: nullable(row.requestId),
              traceId: nullable(row.traceId),
              spanId: nullable(row.spanId),
              route: nullable(row.route),
              status: row.status || null,
            }),
          );
        }

        const last = selected.at(-1);
        let nextCursor: string | null = null;

        if (more && last) {
          const data = Buffer.from(
            JSON.stringify({
              filter,
              since,
              until,
              through,
              position: { received: last.receivedAt, id: last.id },
            }),
          ).toString("base64url");

          nextCursor = `${data}.${signature(`cursor:${data}`)}`;
        }

        return contract.logPage.parse({ entries, nextCursor, receivedThrough: through, since });
      },
      catch: (cause) =>
        cause instanceof InvalidOperation || cause instanceof TelemetryNotConfigured
          ? cause
          : new TelemetryUnavailable({
              message: "Runtime logs are temporarily unavailable. Please try again later.",
              cause,
            }),
    });

  return { credentials, ingest, query };
};
