import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { fleets } from "../src/lib/server/schema.ts";
import { createReporting } from "../src/lib/server/reporting.ts";
import { createTestEnvironment } from "./environment.ts";

const batch = z.object({
  batch: z.array(
    z.object({
      event: z.string(),
      distinct_id: z.string(),
      properties: z.record(z.string(), z.json()),
    }),
  ),
});

describe("Installation reporting with synthetic PostHog transport", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let reporter: ReturnType<typeof createReporting>;
  const requests: z.infer<typeof batch>[] = [];

  const owner = {
    id: "synthetic-owner",
    name: "Private name",
    email: "owner@example.test",
    role: "owner" as const,
    admin: true,
    creator: true,
  };

  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);

    expect(request.url).toBe("https://eu.i.posthog.com/batch/");
    requests.push(batch.parse(await request.json()));

    return Response.json({ status: 1 });
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();
    reporter = createReporting(
      {
        ...environment.configuration,
        PLATFORM_USAGE_REPORTING: undefined,
        PLATFORM_CRASH_REPORTING: undefined,
      },
      environment.database.db,
      transport,
    );
  });

  afterAll(async () => {
    await reporter?.close();
    await environment?.close();
  });

  it("defaults to opt-out, persists a random installation identity and excludes private data", async () => {
    const status = await reporter.read(owner);

    expect(status.effective).toEqual({ usage: true, crashes: true });
    expect(z.uuid().safeParse(status.installationId).success).toBe(true);
    expect(
      (
        await createReporting(environment.configuration, environment.database.db, transport).read(
          owner,
        )
      ).installationId,
    ).toBe(status.installationId);
    reporter.active(owner.id);
    await reporter.flush();

    const preview = await reporter.preview(owner);

    expect(preview.properties.active_management_users).toBe(1);
    expect(JSON.stringify(preview)).not.toMatch(
      /synthetic-owner|owner@example|Private name|localhost/,
    );
    reporter.operation({
      operation: "rollback",
      outcome: "succeeded",
      elapsed_ms: 1234,
      attempt: 1,
    });
    await reporter.flush();
    expect(
      requests
        .flatMap((request) => request.batch)
        .find((event) => event.event === "operation_completed"),
    ).toMatchObject({
      event: "operation_completed",
      distinct_id: `installation:${status.installationId}`,
      properties: {
        operation: "rollback",
        elapsed_ms: 1234,
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
  });

  it("disables categories independently, discards buffered events, and never exports exception messages", async () => {
    requests.length = 0;
    reporter.operation({ operation: "deploy", outcome: "failed", elapsed_ms: 1, attempt: 1 });
    // Let capture enqueue without flushing the SDK, then revoke its generation.
    await reporter.preview(owner);
    await reporter.update(owner, { usage: false, crashes: true });
    reporter.operation({ operation: "deploy", outcome: "succeeded", elapsed_ms: 1, attempt: 1 });
    const error = new TypeError("private token and owner@example.test");
    error.stack = `${error.toString()}\n    at execute (/home/private-company/apps/control-plane/src/lib/server/jobs.ts:12:3)`;
    reporter.exception(error);
    await reporter.flush();

    const events = requests.flatMap((request) => request.batch);

    expect(events.map((event) => event.event)).toEqual(["$exception"]);
    expect(JSON.stringify(events)).not.toMatch(/private token|owner@example|private-company/);
    expect(events[0]?.properties["$exception_list"]).toEqual([
      {
        type: "TypeError",
        value: "Widefleet control_plane TypeError",
        stacktrace: {
          type: "raw",
          frames: [
            {
              filename: "apps/control-plane/src/lib/server/jobs.ts",
              lineno: 12,
              colno: 3,
              function: "execute",
              platform: "custom",
              lang: "javascript",
              in_app: true,
              resolved: true,
            },
          ],
        },
      },
    ]);
    await reporter.update(owner, { usage: false, crashes: false });
    requests.length = 0;
    reporter.exception(new Error("off"));
    await reporter.flush();
    expect(requests).toEqual([]);
  });

  it("enforces administrator access and environment overrides", async () => {
    await expect(
      reporter.update({ ...owner, admin: false }, { usage: true, crashes: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const managed = createReporting(environment.configuration, environment.database.db, transport);

    const status = await managed.update(owner, { usage: true, crashes: true });

    expect(status.managed).toEqual({ usage: true, crashes: true });
    expect(status.effective).toEqual({ usage: false, crashes: false });
    requests.length = 0;
    managed.operation({ operation: "deploy", outcome: "succeeded", elapsed_ms: 1, attempt: 1 });
    managed.exception(new Error("managed off"));
    await managed.flush();
    expect(requests).toEqual([]);
    await managed.close();
  });

  it("bounds a fresh reporter to 100 crash events per observation window", async () => {
    const limited = createReporting(
      { ...environment.configuration, PLATFORM_CRASH_REPORTING: true },
      environment.database.db,
      transport,
    );

    requests.length = 0;

    for (let index = 0; index < 105; index += 1) {
      limited.exception(new Error("synthetic exception"));
      await limited.flush();
    }

    expect(requests.flatMap((request) => request.batch)).toHaveLength(100);
    await limited.close();
  });

  it("keeps all 20 runtime versions when unused fleets also exist", async () => {
    const records = await environment.database.db
      .insert(fleets)
      .values([
        { name: "unused-reporting-fixture", appliedRuntime: null },
        ...Array.from({ length: 20 }, (_, index) => ({
          name: `reporting-version-${index}`,
          appliedRuntime: { version: `1.0.${index}`, checksum: "a".repeat(64) },
        })),
      ])
      .returning({ id: fleets.id });

    try {
      const preview = await reporter.preview(owner);
      expect(preview.properties.runtime_versions).toHaveLength(20);
      expect(preview.properties.runtime_versions_capped).toBe(false);
    } finally {
      await environment.database.db.delete(fleets).where(
        inArray(
          fleets.id,
          records.map((record) => record.id),
        ),
      );
    }
  });

  it("contains transport failures without breaking observed operations", async () => {
    const failing = createReporting(
      { ...environment.configuration, PLATFORM_USAGE_REPORTING: true },
      environment.database.db,
      () => Promise.reject(new Error("offline")),
    );

    failing.operation({
      operation: "runtime_update",
      outcome: "succeeded",
      elapsed_ms: 55,
      attempt: 1,
    });
    await expect(failing.flush()).resolves.toBeUndefined();
    await failing.close();
  });
});
