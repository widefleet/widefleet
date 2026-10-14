import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as contract from "@platform/contracts";
import { cloudflareLogRecords } from "@platform/app-runtime/logs";
import { createCloudflareLogs } from "../src/lib/server/cloudflare-logs.ts";
import { createTelemetry } from "../src/lib/server/telemetry.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { apps, artifacts, deployments } from "../src/lib/server/schema.ts";
import { InvalidOperation, TelemetryUnavailable } from "../src/lib/server/errors.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { createTestEnvironment } from "./environment.ts";

const principal = {
  id: "fixture-owner",
  name: "Fixture",
  email: "fixture@example.test",
  role: "member",
  admin: false,
  creator: true,
} satisfies Parameters<ReturnType<typeof createTelemetry>["query"]>[0];

const configuration = {
  CLOUDFLARE_ACCOUNT_ID: "fixture-account",
  CLOUDFLARE_API_TOKEN: "private-fixture-token",
  APP_RUNTIME_NAME: "fixture-runtime",
};

const now = Date.now() - 5000;

const logEvent = (
  appId: string,
  deploymentId: string,
  id = crypto.randomUUID(),
  message = "fixture log",
) => ({
  $metadata: { id },
  $workers: { scriptName: configuration.APP_RUNTIME_NAME },
  source: cloudflareLogRecords(
    {
      logs: [{ timestamp: now, level: "info", message: [message] }],
      exceptions: [],
      eventTimestamp: now,
      outcome: "ok",
      truncated: false,
    },
    { appId, deploymentId, buildId: "fixture-build" },
    now + 1000,
  )[0],
});

const requestSchema = z.object({
  dry: z.boolean(),
  view: z.literal("events"),
  limit: z.number(),
  offset: z.string().optional(),
  timeframe: z.object({ from: z.number(), to: z.number() }),
  parameters: z.object({
    datasets: z.array(z.string()),
    filterCombination: z.string(),
    filters: z.array(z.json()),
  }),
});

describe("Cloudflare logs through the shared authorized service", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let fixture: Awaited<ReturnType<typeof seedDeployment>>;
  let telemetry: ReturnType<typeof createTelemetry>;
  let requests: z.infer<typeof requestSchema>[];
  let events: ReturnType<typeof logEvent>[];
  let upstreamStatus: number;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    fixture = await seedDeployment(environment.database.db);
    await environment.database.db.insert(deployments).values({
      id: fixture.deploymentId,
      appId: fixture.appId,
      artifactId: fixture.artifact.id,
      requestId: crypto.randomUUID(),
    });
    await environment.database.db
      .update(artifacts)
      .set({
        metadata: {
          ...fixture.artifact.metadata,
          debug: { build_id: "fixture-build", source_maps: {} },
        },
      })
      .where(eq(artifacts.id, fixture.artifact.id));
    telemetry = createTelemetry(
      environment.database.db,
      createStorage(environment.configuration),
      environment.configuration,
      createCloudflareLogs(configuration, async (url, options) => {
        expect(url).toBe(
          "https://api.cloudflare.com/client/v4/accounts/fixture-account/workers/observability/telemetry/query",
        );
        expect(new Headers(options?.headers).get("authorization")).toBe(
          "Bearer private-fixture-token",
        );
        expect(options?.redirect).toBe("error");
        const body = requestSchema.parse(JSON.parse(z.string().parse(options?.body)));
        requests.push(body);

        if (upstreamStatus !== 200)
          return new Response("private upstream details", { status: upstreamStatus });

        const start = body.offset
          ? events.findIndex((entry) => entry.$metadata.id === body.offset) + 1
          : 0;

        return Response.json({
          success: true,
          result: { events: { events: events.slice(start, start + body.limit) } },
        });
      }),
    );
  });
  beforeEach(() => {
    requests = [];
    upstreamStatus = 200;
    events = [logEvent(fixture.appId, fixture.deploymentId)];
  });
  afterAll(async () => {
    await environment.close();
  });

  const query = (input: Partial<z.infer<typeof contract.logQuery>> = {}, actor = principal) =>
    telemetry.query(actor, contract.logQuery.parse({ appId: fixture.appId, ...input }));

  it("checks app permissions before making any upstream query", async () => {
    for (const result of [
      await query({}, { ...principal, id: "outsider" }),
      await query({ appId: crypto.randomUUID() }),
    ]) {
      expect(result.isErr()).toBe(true);
      expect(result.isErr() && result.error).toMatchObject({ code: "NOT_FOUND" });
    }

    expect(requests).toHaveLength(0);
  });

  it("scopes every query to this installation's runtime and authorized app", async () => {
    const page = (await query()).unwrap();
    expect(page.entries).toMatchObject([
      { id: events[0]?.$metadata.id, message: "fixture log", deploymentId: fixture.deploymentId },
    ]);
    expect(requests[0]).toMatchObject({
      dry: true,
      view: "events",
      parameters: { datasets: ["cloudflare-workers"], filterCombination: "and" },
    });
    expect(requests[0]?.parameters.filters).toEqual(
      expect.arrayContaining([
        { key: "$workers.scriptName", type: "string", operation: "eq", value: "fixture-runtime" },
        { key: "appId", type: "string", operation: "eq", value: fixture.appId },
        { key: "widefleetLog", type: "number", operation: "eq", value: 1 },
      ]),
    );
    expect(telemetry.credentials(fixture.appId)).toBeNull();
  });

  it("signs pagination and keeps time boundaries fixed across pages", async () => {
    events = Array.from({ length: 3 }, () => logEvent(fixture.appId, fixture.deploymentId));
    const first = (await query({ limit: 1 })).unwrap();
    expect(first.nextCursor).not.toBeNull();
    const second = (await query({ limit: 1, cursor: first.nextCursor ?? "" })).unwrap();
    expect(second.entries[0]?.id).toBe(events[1]?.$metadata.id);
    expect(second.receivedThrough).toBe(first.receivedThrough);
    expect(second.since).toBe(first.since);
    expect(requests[1]?.timeframe).toEqual(requests[0]?.timeframe);
    expect(requests[1]?.offset).toBe(first.entries[0]?.id);

    for (const input of [
      { limit: 2, cursor: first.nextCursor ?? "" },
      { limit: 1, cursor: `${first.nextCursor}x` },
    ]) {
      const result = await query(input);
      expect(result.isErr() && result.error).toBeInstanceOf(InvalidOperation);
    }

    expect(requests).toHaveLength(2);
    await environment.database.db
      .update(apps)
      .set({ ownerId: "another-owner" })
      .where(eq(apps.id, fixture.appId));

    try {
      const denied = await query({ limit: 1, cursor: first.nextCursor ?? "" });
      expect(denied.isErr() && denied.error).toMatchObject({ code: "NOT_FOUND" });
      expect(requests).toHaveLength(2);
    } finally {
      await environment.database.db
        .update(apps)
        .set({ ownerId: principal.id })
        .where(eq(apps.id, fixture.appId));
    }
  });

  it("translates level, request, trace, source and literal case-insensitive text filters", async () => {
    (
      await query({
        level: "warn",
        source: "browser",
        requestId: "request-1",
        traceId: "a".repeat(32),
        query: 'hello.*[世界]"',
      })
    ).unwrap();
    expect(requests[0]?.parameters.filters).toEqual(
      expect.arrayContaining([
        { key: "severity", type: "number", operation: "gte", value: 13 },
        { key: "record.source", type: "string", operation: "eq", value: "browser" },
        { key: "record.requestId", type: "string", operation: "eq", value: "request-1" },
        { key: "record.traceId", type: "string", operation: "eq", value: "a".repeat(32) },
        {
          key: "record.body",
          type: "string",
          operation: "regex",
          value: '(?i)hello\\.\\*\\[世界\\]"',
        },
      ]),
    );
  });

  it("validates deployments and matches browser errors from that build", async () => {
    const missing = await query({ deploymentId: crypto.randomUUID() });
    expect(missing.isErr() && missing.error).toMatchObject({ code: "NOT_FOUND" });
    expect(requests).toHaveLength(0);
    (await query({ deploymentId: fixture.deploymentId })).unwrap();
    expect(requests[0]?.parameters.filters).toContainEqual({
      kind: "group",
      filterCombination: "or",
      filters: [
        {
          key: "record.deploymentId",
          operation: "eq",
          type: "string",
          value: fixture.deploymentId,
        },
        {
          kind: "group",
          filterCombination: "and",
          filters: [
            { key: "record.source", operation: "eq", type: "string", value: "browser" },
            { key: "record.buildId", operation: "eq", type: "string", value: "fixture-build" },
          ],
        },
      ],
    });
  });

  it("follows tail receive time independently of the original event time", async () => {
    const since = new Date(now - 60_000).toISOString();
    const receivedAfter = String((now + 500) * 1000 + 1);
    const page = (await query({ since, receivedAfter })).unwrap();
    expect(page.entries).toHaveLength(1);
    expect(requests[0]?.parameters.filters).toContainEqual({
      key: "receivedTime",
      type: "number",
      operation: "gte",
      value: now + 501,
    });
    expect(requests[0]?.timeframe.from).toBe(now - 60_000);
  });

  it.each([403, 429, 500])("maps upstream HTTP %s to a safe unavailable error", async (status) => {
    upstreamStatus = status;
    const result = await query();
    expect(result.isErr() && result.error).toBeInstanceOf(TelemetryUnavailable);
    expect(result.isErr() && result.error.message).not.toContain("private");
  });

  it("rejects unexpected app or runtime attribution in returned events", async () => {
    events = [logEvent(crypto.randomUUID(), fixture.deploymentId)];
    const otherApp = await query();
    expect(otherApp.isErr()).toBe(true);
    events = [
      {
        ...logEvent(fixture.appId, fixture.deploymentId),
        $workers: { scriptName: "another-runtime" },
      },
    ];
    expect((await query()).isErr()).toBe(true);
  });
});
